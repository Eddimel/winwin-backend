import dotenv from "dotenv"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import crypto from "crypto"
import { prisma } from "./lib/prisma.js"
import { requireAuth } from "./middleware/requireAuth.js"
import fetch from "node-fetch"

dotenv.config()
console.log("ENV CHECK:", process.env.NODE_ENV)

const app = express()

app.use(express.json())
app.use(cookieParser())

/* =====================================================
   CORS CONFIGURATION
===================================================== */

const allowedOrigins = [
  "https://app.winwin.ovh",
  "https://winwin.ovh",
  "http://localhost:5173"
]

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true)
      if (allowedOrigins.includes(origin)) {
        return callback(null, true)
      }
      console.warn("Blocked by CORS:", origin)
      return callback(null, false)
    },
    credentials: true,
  })
)

/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: "OK", database: "connected" })
  } catch {
    res.status(500).json({ status: "ERROR", database: "not connected" })
  }
})

/* =====================================================
   INTERNAL PRODUCT SYNC (PRODUCT + VARIANT)
===================================================== */

app.post("/internal/sync-products", async (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"]

    if (secret !== process.env.INTERNAL_SYNC_SECRET) {
      return res.status(403).json({ error: "Unauthorized" })
    }

    const shopRecord = await prisma.shop.findFirst({
      where: { isApproved: true }
    })

    if (!shopRecord) {
      return res.status(400).json({ error: "No approved shop found" })
    }

    const accessToken = shopRecord.accessToken
    const shop = shopRecord.shop

    let synced = 0
    let skipped = 0
    let nextUrl = `https://${shop}/admin/api/2026-01/products.json?status=active&limit=250`

    while (nextUrl) {
      const response = await fetch(nextUrl, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json"
        }
      })

      const data = await response.json()

      if (!data.products) {
        throw new Error("Invalid Shopify response")
      }

      for (const product of data.products) {

        // 1️⃣ Upsert Product (parent)
        const parent = await prisma.product.upsert({
          where: { shopifyProductId: String(product.id) },
          update: {
            title: product.title,
            description: product.body_html,
            imageUrl: product.image?.src || null,
            tags: product.tags || null,
            isActive: product.status === "active",
            archived: product.status !== "active"
          },
          create: {
            shopifyProductId: String(product.id),
            title: product.title,
            description: product.body_html,
            imageUrl: product.image?.src || null,
            tags: product.tags || null,
            isActive: product.status === "active",
            archived: product.status !== "active"
          }
        })

        // 2️⃣ Upsert Variants
        for (const variant of product.variants) {

          if (!variant.sku || variant.sku.trim() === "") {
            skipped++
            continue
          }

          await prisma.productVariant.upsert({
            where: { shopifyVariantId: String(variant.id) },
            update: {
              sku: variant.sku,
              priceBase: parseFloat(variant.price) || 0,
              stock: variant.inventory_quantity || 0,
              productId: parent.id
            },
            create: {
              shopifyVariantId: String(variant.id),
              sku: variant.sku,
              priceBase: parseFloat(variant.price) || 0,
              stock: variant.inventory_quantity || 0,
              productId: parent.id
            }
          })

          synced++
        }
      }

      const linkHeader = response.headers.get("link")

      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>; rel="next"/)
        nextUrl = match ? match[1] : null
      } else {
        nextUrl = null
      }
    }

    return res.json({ success: true, synced, skipped })

  } catch (error) {
    console.error("SYNC ERROR:", error)
    return res.status(500).json({ error: "Sync failed" })
  }
})

/* =====================================================
   AUTH SYSTEM (OTP)
===================================================== */

app.post("/auth/request-otp", async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: "Phone is required" })

    let customer = await prisma.customer.findUnique({
      where: { phone },
      include: { security: true }
    })

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          phone,
          name: "Pending User",
          security: { create: {} }
        },
        include: { security: true }
      })
    }

    const otp = crypto.randomInt(100000, 999999).toString()
    const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex")
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    await prisma.otpCode.deleteMany({ where: { customerId: customer.id } })

    await prisma.otpCode.create({
      data: {
        customerId: customer.id,
        code: hashedOtp,
        expiresAt
      }
    })

    console.log("DEV OTP:", otp)
    res.json({ message: "OTP sent" })

  } catch {
    res.status(500).json({ error: "Server error" })
  }
})

app.post("/auth/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body
    if (!phone || !otp)
      return res.status(400).json({ error: "Phone and OTP required" })

    const customer = await prisma.customer.findUnique({
      where: { phone },
      include: { security: true }
    })

    if (!customer)
      return res.status(400).json({ error: "Customer not found" })

    const otpRecord = await prisma.otpCode.findFirst({
      where: { customerId: customer.id }
    })

    if (!otpRecord || otpRecord.expiresAt < new Date())
      return res.status(400).json({ error: "OTP invalid or expired" })

    const hashedInput = crypto.createHash("sha256").update(otp).digest("hex")

    if (hashedInput !== otpRecord.code)
      return res.status(400).json({ error: "Invalid OTP" })

    await prisma.otpCode.deleteMany({ where: { customerId: customer.id } })

    const now = new Date()

    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    const absoluteExpiresAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000)

    const newSession = await prisma.customerSession.create({
      data: {
        customerId: customer.id,
        isActive: true,
        deviceHash: crypto.randomBytes(32).toString("hex"),
        expiresAt,
        absoluteExpiresAt
      }
    })

    res.cookie("session_id", newSession.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 90 * 24 * 60 * 60 * 1000
    })

    res.json({ message: "Authenticated" })

  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Server error" })
  }
})

app.post("/auth/logout", requireAuth, async (req, res) => {
  await prisma.customerSession.update({
    where: { id: req.session.id },
    data: { isActive: false }
  })

  res.clearCookie("session_id")
  res.json({ message: "Logout successful" })
})

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ customer: req.customer })
})

/* =====================================================
   CATALOGUE (MODE B)
===================================================== */

app.get("/api/catalogue", requireAuth, async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    include: {
      variants: true
    }
  })

  res.json({
    success: true,
    data: products
  })
})

/* =====================================================
   SHOPIFY OAUTH
===================================================== */

app.get("/auth/shopify", (req, res) => {
  const shop = req.query.shop

  if (!shop) {
    return res.status(400).send("Missing shop parameter")
  }

  const state = crypto.randomBytes(16).toString("hex")

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=${process.env.SHOPIFY_SCOPES}` +
    `&redirect_uri=${process.env.SHOPIFY_REDIRECT_URI}` +
    `&state=${state}`

  return res.redirect(installUrl)
})

app.get("/auth/shopify/callback", async (req, res) => {
  const { shop, code } = req.query

  if (!shop || !code) {
    return res.status(400).send("Missing shop or code")
  }

  try {
    const response = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          code,
        }),
      }
    )

    const data = await response.json()

    if (!data.access_token) {
      return res.status(500).send("OAuth token exchange failed")
    }

    await prisma.shop.upsert({
      where: { shop },
      update: {
        accessToken: data.access_token,
        scope: data.scope,
      },
      create: {
        shop,
        accessToken: data.access_token,
        scope: data.scope,
        isApproved: false,
      },
    })

    return res.send("Shopify OAuth success & token stored")
  } catch {
    return res.status(500).send("OAuth failed")
  }
})

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})