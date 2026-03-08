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
   INTERNAL PRODUCT SYNC (MASTER v4)
===================================================== */

app.post("/internal/sync-products", async (req, res) => {
  try {
    const providedSecret = req.headers["x-internal-secret"]

    if (!providedSecret || providedSecret !== process.env.INTERNAL_SYNC_SECRET) {
      return res.status(403).json({ error: "Forbidden" })
    }

    const shop = await prisma.shop.findFirst({
      where: { isApproved: true }
    })

    if (!shop) {
      return res.status(400).json({ error: "No approved shop found" })
    }

    const response = await fetch(
      `https://${shop.shop}/admin/api/2026-01/products.json?limit=250`,
      {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": shop.accessToken,
          "Content-Type": "application/json"
        }
      }
    )

    const data = await response.json()

    if (!data.products) {
      console.error("Invalid Shopify response:", data)
      return res.status(500).json({ error: "Invalid Shopify response" })
    }

    let synced = 0
    let skipped = 0

    for (const product of data.products) {

      for (const variant of product.variants) {

        if (!variant.sku) {
          skipped++
          continue
        }

        const stock =
          typeof variant.inventory_quantity === "number"
            ? variant.inventory_quantity
            : 0

        const name =
          variant.title && variant.title !== "Default Title"
            ? `${product.title} - ${variant.title}`
            : product.title

        await prisma.product.upsert({
          where: {
            shopifyVariantId: String(variant.id)
          },
          update: {
            sku: variant.sku,
            name,
            description: product.body_html,
            isActive: product.status === "active",
            archived: product.status !== "active",
            stock,
            priceBase: parseFloat(variant.price || 0),
            imageUrl: product.image?.src || null,
            tags: product.tags || null,
            shopifyProductId: String(product.id)
          },
          create: {
            sku: variant.sku,
            name,
            description: product.body_html,
            isActive: product.status === "active",
            archived: product.status !== "active",
            stock,
            moq: 1,
            priceBase: parseFloat(variant.price || 0),
            currency: "EUR",
            imageUrl: product.image?.src || null,
            tags: product.tags || null,
            shopifyProductId: String(product.id),
            shopifyVariantId: String(variant.id)
          }
        })

        synced++
      }
    }

    return res.json({
      success: true,
      synced,
      skipped
    })

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

    const expiresAt = new Date(
      now.getTime() + 90 * 24 * 60 * 60 * 1000
    )

    const absoluteExpiresAt = new Date(
      now.getTime() + 180 * 24 * 60 * 60 * 1000
    )

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

app.get("/api/catalogue", requireAuth, async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true }
  })

  res.json({
    success: true,
    data: { catalogue: products }
  })
})

/* =====================================================
   SHOPIFY OAUTH 2026
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
      console.error("Token exchange failed:", data)
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

    console.log("Shop installed & token stored:", shop)

    return res.send("Shopify OAuth success & token stored")
  } catch (error) {
    console.error("OAuth callback error:", error)
    return res.status(500).send("OAuth failed")
  }
})

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})