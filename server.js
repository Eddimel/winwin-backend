import dotenv from "dotenv"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import crypto from "crypto"
import { prisma } from "./lib/prisma.js"
import { requireAuth } from "./middleware/requireAuth.js"

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

/* HEALTH */
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: "OK", database: "connected" })
  } catch {
    res.status(500).json({ status: "ERROR", database: "not connected" })
  }
})

/* REQUEST OTP */
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

/* VERIFY OTP */
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

/* LOGOUT */
app.post("/auth/logout", requireAuth, async (req, res) => {
  await prisma.customerSession.update({
    where: { id: req.session.id },
    data: { isActive: false }
  })

  res.clearCookie("session_id")
  res.json({ message: "Logout successful" })
})

/* ME */
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ customer: req.customer })
})

/* CATALOGUE */
app.get("/api/catalogue", requireAuth, async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true }
  })

  res.json({
    success: true,
    data: { catalogue: products }
  })
})

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})