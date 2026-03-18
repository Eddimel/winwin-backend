import crypto from "crypto"
import { prisma } from "../lib/prisma.js"

export async function requireShopifyAdmin(req, res, next) {
  try {

    const shop = req.query.shop || req.headers["x-shop-domain"]
    const hmac = req.query.hmac

    if (!shop) {
      return res.status(401).json({ error: "Missing shop parameter" })
    }

    if (!hmac) {
      return res.status(401).json({ error: "Missing HMAC" })
    }

    const shopRecord = await prisma.shop.findUnique({
      where: { shop }
    })

    if (!shopRecord) {
      return res.status(403).json({ error: "Shop not registered" })
    }

    if (!shopRecord.accessToken) {
      return res.status(403).json({ error: "Missing access token" })
    }

    if (!shopRecord.isApproved) {
      return res.status(403).json({ error: "Shop not approved" })
    }

    const query = { ...req.query }
    delete query.hmac

    const message = Object.keys(query)
      .sort()
      .map(key => `${key}=${query[key]}`)
      .join("&")

    const generatedHash = crypto
      .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET)
      .update(message)
      .digest("hex")

    if (generatedHash !== hmac) {
      return res.status(401).json({ error: "Invalid HMAC" })
    }

    req.shop = shopRecord

    next()

  } catch (error) {
    console.error("SHOPIFY ADMIN AUTH ERROR:", error)
    return res.status(500).json({ error: "Internal auth error" })
  }
}