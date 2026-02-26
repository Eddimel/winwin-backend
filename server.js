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

// ========================================
// CORS — PRODUCTION READY
// ========================================
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

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})