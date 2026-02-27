import dotenv from "dotenv"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import crypto from "crypto"
import { prisma } from "./lib/prisma.js"
import { requireAuth } from "./middleware/requireAuth.js"

dotenv.config()

const app = express()

app.use(express.json())
app.use(cookieParser())

/*
  DEV MODE CORS (Shopify Embedded compatible)
  - origin: true → reflète dynamiquement l'origine entrante
  - credentials: true → autorise cookie cross-site
*/
app.use(
  cors({
    origin: true,
    credentials: true,
  })
)

/* ===============================
   HEALTH CHECK
================================ */

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: "OK", database: "connected" })
  } catch (error) {
    console.error("HEALTH ERROR:", error)
    res.status(500).json({ status: "ERROR", database: "not connected" })
  }
})

/* ===============================
   REQUEST OTP
================================ */

app.post("/auth/request-otp", async (req, res) => {
  try {
    const { phone } = req.body

    if (!phone) {
      return res.status(400).json({ error: "Phone is required" })
    }

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

    if (
      customer.security?.lockedUntil &&
      customer.security.lockedUntil > new Date()
    ) {
      return res.status(429).json({
        error: "Account locked. Try again later."
      })
    }

    const otp = crypto.randomInt(100000, 999999).toString()

    const hashedOtp = crypto
      .createHash("sha256")
      .update(otp)
      .digest("hex")

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    await prisma.otpCode.deleteMany({
      where: { customerId: customer.id }
    })

    await prisma.otpCode.create({
      data: {
        customerId: customer.id,
        code: hashedOtp,
        expiresAt
      }
    })

    console.log("DEV OTP:", otp)

    res.json({ message: "OTP sent" })

  } catch (error) {
    console.error("REQUEST OTP ERROR:", error)
    res.status(500).json({ error: "Server error" })
  }
})

/* ===============================
   VERIFY OTP
================================ */

app.post("/auth/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body

    if (!phone || !otp) {
      return res.status(400).json({ error: "Phone and OTP required" })
    }

    const customer = await prisma.customer.findUnique({
      where: { phone },
      include: { security: true }
    })

    if (!customer) {
      return res.status(400).json({ error: "Customer not found" })
    }

    const otpRecord = await prisma.otpCode.findFirst({
      where: { customerId: customer.id }
    })

    if (!otpRecord || otpRecord.expiresAt < new Date()) {
      return res.status(400).json({ error: "OTP invalid or expired" })
    }

    const hashedInput = crypto
      .createHash("sha256")
      .update(otp)
      .digest("hex")

    if (hashedInput !== otpRecord.code) {
      return res.status(400).json({ error: "Invalid OTP" })
    }

    await prisma.otpCode.deleteMany({
      where: { customerId: customer.id }
    })

    const deviceHash = crypto.randomBytes(32).toString("hex")

    const newSession = await prisma.customerSession.create({
      data: {
        customerId: customer.id,
        isActive: true,
        deviceHash
      }
    })

    await prisma.customerSession.updateMany({
      where: {
        customerId: customer.id,
        id: { not: newSession.id }
      },
      data: { isActive: false }
    })

    res.cookie("session_id", newSession.id, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 30 * 24 * 60 * 60 * 1000
    })

    res.json({ message: "Authenticated" })

  } catch (error) {
    console.error("VERIFY OTP ERROR:", error)
    res.status(500).json({ error: "Server error" })
  }
})

/* ===============================
   LOGOUT
================================ */

app.post("/auth/logout", requireAuth, async (req, res) => {
  await prisma.customerSession.update({
    where: { id: req.session.id },
    data: { isActive: false }
  })

  res.clearCookie("session_id", {
    httpOnly: true,
    secure: true,
    sameSite: "none"
  })

  res.json({ message: "Logout successful" })
})

/* ===============================
   SECURE USER INFO
================================ */

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ customer: req.customer })
})

/* ===============================
   SECURE CATALOGUE (ENTERPRISE CLEAN)
================================ */

app.get("/api/catalogue", requireAuth, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true }
    })

    res.status(200).json({
      success: true,
      data: {
        catalogue: products,
        count: products.length
      },
      error: null
    })

  } catch (error) {
    console.error("CATALOGUE ERROR:", error)

    res.status(500).json({
      success: false,
      data: null,
      error: "Internal server error"
    })
  }
})

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})