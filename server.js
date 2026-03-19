import dotenv from "dotenv"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import crypto from "crypto"
import fetch from "node-fetch"
import { fetchWithRetry } from "./services/fetchWithRetry.js"
import { createDraftOrder } from "./services/shopifyService.js"
import { syncShopifyCustomer } from "./services/shopifyCustomerService.js"

import { prisma } from "./lib/prisma.js"
import { requireShopifyAdmin } from "./middleware/requireShopifyAdmin.js"
import { requireAuth } from "./middleware/requireAuth.js"
import {
  addItem,
  updateItem,
  removeItem,
  getCart
} from "./services/cartService.js"

dotenv.config()

const app = express()

app.use((req, res, next) => {
  if (req.originalUrl === "/webhooks/products") {
    return next()
  }
  express.json()(req, res, next)
})
app.use(cookieParser())

/* =====================================================
CATALOG CACHE
===================================================== */

let catalogCache = null

async function buildCatalogCache() {

  const collections = await prisma.collection.findMany({
    where: { isVisible: true },
    include: {
      products: {
        include: {
          product: {
            include: {
              variants: true
            }
          }
        }
      }
    }
  })

  catalogCache = collections.map(c => ({
    id: c.id,
    title: c.title,
    handle: c.handle,
    products: c.products.map(p => ({
      id: p.product.id,
      title: p.product.title,
      description: p.product.description,
      image: p.product.imageUrl,
      tags: p.product.tags ? p.product.tags.split(",") : [],
      variants: p.product.variants.map(v => ({
        id: v.id,
        price: v.priceB2B ?? v.priceBase,
        stock: v.stock,
        moq: v.moq
      }))
    }))
  }))

  console.log("CATALOG CACHE BUILT")
}

/* =====================================================
PRICING CACHE
===================================================== */

let variantMap = new Map()
let tierMap = new Map()
let packagingMap = new Map()
let bundleMap = new Map()

async function buildPricingCache() {

  const variants = await prisma.productVariant.findMany()

  variants.forEach(v => {
    variantMap.set(v.id, v)
  })

  const tiers = await prisma.variantPriceTier.findMany()

  tiers.forEach(t => {
    if (!tierMap.has(t.variantId)) {
      tierMap.set(t.variantId, [])
    }
    tierMap.get(t.variantId).push(t)
  })

  const packaging = await prisma.variantPackaging.findMany()

  packaging.forEach(p => {
    if (!packagingMap.has(p.variantId)) {
      packagingMap.set(p.variantId, [])
    }
    packagingMap.get(p.variantId).push(p)
  })

  const bundles = await prisma.productBundle.findMany({
    include: { items: true }
  })

  bundles.forEach(b => {
    bundleMap.set(b.id, b)
  })

  console.log("PRICING CACHE BUILT")
}

/* =====================================================
CORS
===================================================== */

const allowedOrigins = [
  "https://app.winwin.ovh",
  "https://winwin.ovh",
  "http://localhost:5173"
]

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      if (allowedOrigins.includes(origin)) return callback(null, true)
      return callback(null, false)
    },
    credentials: true
  })
)

/* =====================================================
HEALTH
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

    console.log("NEW TOKEN SCOPES:", data.scope)

    await prisma.shop.upsert({
      where: { shop },
      update: {
        accessToken: data.access_token,
        scope: data.scope,
        isApproved: true
      },
      create: {
        shop,
        accessToken: data.access_token,
        scope: data.scope,
        isApproved: true
      },
    })

    return res.send("Shopify OAuth success & token stored")

  } catch (error) {
    console.error(error)
    return res.status(500).send("OAuth failed")
  }
})

/* =====================================================
AUTH - REQUEST OTP
===================================================== */

app.post("/auth/request-otp", async (req, res) => {
  try {
    const { phone } = req.body

    if (!phone) {
      return res.status(400).json({ error: "phone required" })
    }

    const customer = await prisma.customer.findUnique({
      where: { phone }
    })

    if (!customer) {
      return res.status(404).json({ error: "customer not found" })
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    await prisma.otpCode.create({
      data: {
        customerId: customer.id,
        code: otp,
        expiresAt
      }
    })

    console.log("OTP CODE:", otp)

    res.json({ success: true })

  } catch (error) {
    console.error("OTP REQUEST ERROR:", error)
    res.status(500).json({ error: "OTP generation failed" })
  }
})

/* =====================================================
AUTH - VERIFY OTP
===================================================== */

app.post("/auth/verify-otp", async (req, res) => {
  try {
    const { phone, code } = req.body

    const customer = await prisma.customer.findUnique({
      where: { phone }
    })

    if (!customer) {
      return res.status(404).json({ error: "customer not found" })
    }

    const otp = await prisma.otpCode.findFirst({
      where: { customerId: customer.id, code },
      orderBy: { createdAt: "desc" }
    })

    if (!otp) {
      return res.status(401).json({ error: "invalid code" })
    }

    if (otp.expiresAt < new Date()) {
      return res.status(401).json({ error: "OTP expired" })
    }

    const sessionId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    await prisma.customerSession.create({
      data: {
        id: sessionId,
        customerId: customer.id,
        deviceHash: crypto.randomUUID(),
        expiresAt,
        absoluteExpiresAt: expiresAt
      }
    })

    res.cookie("winwin_session", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    })

    res.json({ success: true })

  } catch (error) {
    console.error("OTP VERIFY ERROR:", error)
    res.status(500).json({ error: "OTP verify failed" })
  }
})

/* =====================================================
AUTH SESSION
===================================================== */

app.get("/auth/session", async (req, res) => {
  try {
    const sessionId = req.cookies.winwin_session

    if (!sessionId) {
      return res.json({ authenticated: false })
    }

    const session = await prisma.customerSession.findUnique({
      where: { id: sessionId }
    })

    if (!session || !session.isActive) {
      return res.json({ authenticated: false })
    }

    res.json({ authenticated: true })

  } catch (error) {
    console.error("SESSION ERROR:", error)
    res.status(500).json({ error: "session error" })
  }
})

/* =====================================================
CART ROUTES
===================================================== */

app.post("/api/cart/add", requireAuth, async (req, res) => {
  try {
    const { variantId, quantity } = req.body

    const cart = await addItem(
      req.customer.id,
      variantId,
      quantity,
      { variantMap, tierMap, packagingMap, bundleMap }
    )

    res.json({ success: true, cart })

  } catch (error) {

    console.error("CART ADD ERROR:", error)

    if (error.message === "INSUFFICIENT_STOCK") {
      return res.status(400).json({ error: "Stock insuffisant" })
    }

    if (error.message === "MOQ_NOT_RESPECTED") {
      return res.status(400).json({ error: "MOQ non respecté" })
    }

    return res.status(500).json({ error: "add to cart failed" })
  }
})

/* =====================================================
CHECKOUT
===================================================== */

app.post("/api/cart/checkout", requireAuth, async (req, res) => {
  try {

    const cart = await getCart(
      req.customer.id,
      { variantMap, tierMap, packagingMap, bundleMap }
    )

    await syncShopifyCustomer(req.customer)

    const draft = await createDraftOrder(
      req.customer,
      cart,
      { variantMap, tierMap, packagingMap, bundleMap }
    )

    res.json({
      success: true,
      draftOrderId: draft.id,
      invoiceUrl: draft.invoice_url
    })

  } catch (error) {

    console.error("CHECKOUT ERROR:", error)

    if (error.message === "CUSTOMER_NOT_APPROVED") {
      return res.status(403).json({ error: "Client non approuvé" })
    }

    res.status(500).json({ error: "checkout failed" })
  }
})

/* =====================================================
SYNC PRODUCTS (PAGINATION FIXED)
===================================================== */

app.get(
  "/internal/sync-products",
  process.env.NODE_ENV === "production" ? requireShopifyAdmin : (req, res, next) => next(),
  async (req, res) => {
  try {

    const shop = req.query.shop

    if (!shop) {
      return res.status(400).json({ error: "Missing shop" })
    }

    const shopData = await prisma.shop.findUnique({
      where: { shop }
    })

    if (!shopData || !shopData.accessToken) {
      return res.status(400).json({ error: "Shop not ready" })
    }

    let nextUrl = `https://${shop}/admin/api/2026-01/products.json?status=active&limit=250`
    let totalFetched = 0
    let created = 0
    let updated = 0

    while (nextUrl) {

      const response = await fetchWithRetry(nextUrl, {
        headers: {
          "X-Shopify-Access-Token": shopData.accessToken,
          "Content-Type": "application/json"
        }
      })

      const data = await response.json()

      if (!data.products) {
        return res.status(500).json({ error: "Invalid Shopify response" })
      }

      for (const product of data.products) {

        const dbProduct = await prisma.product.upsert({
          where: { shopifyProductId: product.id.toString() },
          update: {
            title: product.title,
            description: product.body_html || "",
            imageUrl: product.image?.src || null,
            tags: product.tags || ""
          },
          create: {
            shopifyProductId: product.id.toString(),
            title: product.title,
            description: product.body_html || "",
            imageUrl: product.image?.src || null,
            tags: product.tags || ""
          }
        })

        if (dbProduct.createdAt.getTime() === dbProduct.updatedAt.getTime()) {
          created++
        } else {
          updated++
        }

        for (const variant of product.variants) {

          await prisma.productVariant.upsert({
            where: { shopifyVariantId: variant.id.toString() },
            update: {
              priceBase: parseFloat(variant.price),
              stock: variant.inventory_quantity ?? 0,
              sku: variant.sku || null
            },
            create: {
              shopifyVariantId: variant.id.toString(),
              productId: dbProduct.id,
              priceBase: parseFloat(variant.price),
              stock: variant.inventory_quantity ?? 0,
              sku: variant.sku || null,
              moq: 1
            }
          })

        }
      }

      totalFetched += data.products.length

      const linkHeader = response.headers.get("link")

      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>; rel="next"/)
        nextUrl = match ? match[1] : null
      } else {
        nextUrl = null
      }
    }

      // 🔥 REBUILD CACHE AFTER SYNC
      await buildCatalogCache()
      await buildPricingCache()
      
      return res.json({
      success: true,
      created,
      updated,
      total: totalFetched
    })

  } catch (error) {
    console.error("SYNC ERROR:", error)
    res.status(500).json({ error: "Internal error" })
  }
})

/* =====================================================
SHOPIFY WEBHOOK — DEBUG HMAC
===================================================== */

app.post(
  "/webhooks/products",
  express.raw({ type: "application/json" }),
  async (req, res) => {
  try {

    const hmacHeader = req.headers["x-shopify-hmac-sha256"]
    const shop = req.headers["x-shopify-shop-domain"]

    if (!hmacHeader || !shop) {
      return res.status(401).send("Unauthorized")
    }

    // 🔐 RAW BODY
    const rawBody = req.body

    // 🔍 DEBUG
    console.log("SHOPIFY HMAC:", hmacHeader)
    console.log("RAW BODY TYPE:", typeof rawBody)
    console.log("RAW BODY IS BUFFER:", Buffer.isBuffer(rawBody))

    // 🔐 GENERATE HMAC
    const generatedHash = crypto
      .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET)
      .update(rawBody)
      .digest("base64")

    console.log("GENERATED HMAC:", generatedHash)

    // 🔐 COMPARE
    if (generatedHash !== hmacHeader) {
      console.error("INVALID HMAC")
      return res.status(401).send("Invalid signature")
    }

    console.log("WEBHOOK VERIFIED FROM:", shop)

    // 🔥 SYNC BACKGROUND
    fetch(`${process.env.SHOPIFY_APP_URL}/internal/sync-products?shop=${shop}`)
      .catch(err => console.error("Webhook sync error:", err))

    return res.status(200).send("OK")

  } catch (error) {
    console.error("WEBHOOK ERROR:", error)
    return res.status(500).send("Error")
  }
})
/* =====================================================
SERVER
===================================================== */

const PORT = process.env.PORT || 4000

app.listen(PORT, async () => {
  console.log(`Backend running on port ${PORT}`)
  console.log("NODE_ENV:", process.env.NODE_ENV)
  await buildCatalogCache()
  await buildPricingCache()
})