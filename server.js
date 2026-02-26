import dotenv from "dotenv"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import { prisma } from "./lib/prisma.js"
import { requireAuth } from "./middleware/requireAuth.js"

dotenv.config()

const app = express()

app.use(express.json())
app.use(cookieParser())

app.use(
  cors({
    origin: true,
    credentials: true,
  })
)

// ===============================
// HEALTH CHECK
// ===============================
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: "OK", database: "connected" })
  } catch {
    res.status(500).json({ status: "ERROR", database: "not connected" })
  }
})

// ===============================
// PHASE 2 — PROTECTED CATALOGUE
// ===============================
app.get("/api/catalogue", async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        sku: true,
        description: true,
        stock: true,
        moq: true,
        quantityMax: true,
        createdAt: true
      },
      orderBy: {
        createdAt: "desc"
      }
    })

    res.json({
      success: true,
      count: products.length,
      catalogue: products
    })

  } catch (error) {
    console.error(error)
    res.status(500).json({
      success: false,
      error: "Internal server error"
    })
  }
})

// ===============================
// ORDER VALIDATION
// ===============================
app.post("/api/catalogue/validate-order", requireAuth, async (req, res) => {
  try {
    const { items } = req.body

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({
        success: false,
        error: "Items array required"
      })

    const validated = []

    for (const item of items) {

      const product = await prisma.product.findUnique({
        where: { sku: item.sku }
      })

      if (!product || !product.isActive)
        return res.status(404).json({
          success: false,
          error: `Product ${item.sku} not available`
        })

      if (item.quantity < product.moq)
        return res.status(400).json({
          success: false,
          error: `Minimum order quantity for ${item.sku} is ${product.moq}`
        })

      if (product.quantityMax && item.quantity > product.quantityMax)
        return res.status(400).json({
          success: false,
          error: `Maximum allowed quantity for ${item.sku} is ${product.quantityMax}`
        })

      if (product.stock === 0)
        return res.status(400).json({
          success: false,
          error: `Product ${item.sku} is currently unavailable`
        })

      let approvedQuantity = item.quantity
      let adjusted = false

      if (item.quantity > product.stock) {
        approvedQuantity = product.stock
        adjusted = true
      }

      validated.push({
        productId: product.id,
        sku: product.sku,
        requestedQuantity: item.quantity,
        approvedQuantity,
        adjusted
      })
    }

    res.json({
      success: true,
      validated
    })

  } catch (error) {
    console.error(error)
    res.status(500).json({
      success: false,
      error: "Internal server error"
    })
  }
})

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})