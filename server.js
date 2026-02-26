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
    origin: "http://localhost:5173",
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
app.get("/api/catalogue", requireAuth, async (req, res) => {
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
// ORDER VALIDATION (PHASE 2 BASE)
// ===============================
app.post("/api/catalogue/validate-order", requireAuth, async (req, res) => {
  try {
    const { items } = req.body
    const customerId = req.customer.id

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
// LIST MY DRAFT ORDERS
// ===============================
app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    const drafts = await prisma.orderDraft.findMany({
      where: {
        customerId: req.customer.id
      },
      include: {
        items: true
      },
      orderBy: {
        createdAt: "desc"
      }
    })

    res.json({
      success: true,
      count: drafts.length,
      drafts
    })

  } catch {
    res.status(500).json({
      success: false,
      error: "Internal server error"
    })
  }
})

// ===============================
// CONFIRM DRAFT ORDER
// ===============================
app.post("/api/orders/:id/confirm", requireAuth, async (req, res) => {
  try {
    const draftId = req.params.id

    const draft = await prisma.orderDraft.findFirst({
      where: {
        id: draftId,
        customerId: req.customer.id
      }
    })

    if (!draft)
      return res.status(404).json({
        success: false,
        error: "Draft not found"
      })

    if (draft.status !== "PENDING")
      return res.status(400).json({
        success: false,
        error: "Draft already processed"
      })

    await prisma.orderDraft.update({
      where: { id: draftId },
      data: { status: "CONFIRMED" }
    })

    res.json({
      success: true,
      message: "Order confirmed",
      draftId
    })

  } catch {
    res.status(500).json({
      success: false,
      error: "Internal server error"
    })
  }
})

const PORT = 4000

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
})