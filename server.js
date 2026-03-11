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
   INTERNAL CUSTOMER STATUS UPDATE (SECRET PROTECTED)
===================================================== */

app.patch("/internal/customer/:id/status", async (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"]

    if (secret !== process.env.INTERNAL_SYNC_SECRET) {
      return res.status(403).json({ error: "Unauthorized" })
    }

    const { id } = req.params
    const { status } = req.body

    const allowedStatuses = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"]

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const customer = await prisma.customer.findUnique({
      where: { id }
    })

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" })
    }

    await prisma.customer.update({
      where: { id },
      data: { status }
    })

    return res.json({ message: "Status updated" })

  } catch (error) {
    console.error("STATUS UPDATE ERROR:", error)
    return res.status(500).json({ error: "Server error" })
  }
})

/* =====================================================
   ADMIN CUSTOMER MANAGEMENT (TEMP UNPROTECTED)
===================================================== */

app.get("/admin/customers", async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        phone: true,
        name: true,
        email: true,
        status: true,
        createdAt: true
      }
    })

    return res.json({ success: true, data: customers })

  } catch (error) {
    console.error("ADMIN LIST ERROR:", error)
    return res.status(500).json({ error: "Server error" })
  }
})

app.patch("/admin/customers/:id/status", async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body

    const allowedStatuses = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"]

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const customer = await prisma.customer.findUnique({
      where: { id }
    })

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" })
    }

    await prisma.customer.update({
      where: { id },
      data: { status }
    })

    return res.json({ message: "Status updated" })

  } catch (error) {
    console.error("ADMIN STATUS ERROR:", error)
    return res.status(500).json({ error: "Server error" })
  }
})

/* =====================================================
   AUTH SYSTEM
===================================================== */

app.post("/auth/register", async (req, res) => {
  try {
    const { phone, firstName, lastName, email } = req.body

    if (!phone || !firstName || !lastName) {
      return res.status(400).json({ error: "Missing required fields" })
    }

    const existing = await prisma.customer.findUnique({
      where: { phone }
    })

    if (existing) {
      return res.status(409).json({ error: "ALREADY_EXISTS" })
    }

    await prisma.customer.create({
      data: {
        phone,
        firstName,
        lastName,
        email,
        status: "PENDING"
      }
    })

    return res.json({ message: "Registration submitted" })

  } catch (error) {
    console.error("REGISTER ERROR:", error)
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/auth/request-otp", async (req, res) => {
  try {
    const { phone } = req.body

    if (!phone) {
      return res.status(400).json({ error: "Phone is required" })
    }

    const customer = await prisma.customer.findUnique({
      where: { phone }
    })

    if (!customer) {
      return res.status(404).json({ error: "NOT_REGISTERED" })
    }

    if (customer.status === "PENDING") {
      return res.status(403).json({ error: "PENDING_APPROVAL" })
    }

    if (customer.status === "REJECTED") {
      return res.status(403).json({ error: "REJECTED" })
    }

    if (customer.status === "SUSPENDED") {
      return res.status(403).json({ error: "SUSPENDED" })
    }

    const otp = crypto.randomInt(100000, 999999).toString()
    const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex")
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

    return res.json({ message: "OTP sent" })

  } catch (error) {
    console.error("OTP ERROR:", error)
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/auth/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body

    if (!phone || !otp) {
      return res.status(400).json({ error: "Phone and OTP required" })
    }

    const customer = await prisma.customer.findUnique({
      where: { phone }
    })

    if (!customer || customer.status !== "APPROVED") {
      return res.status(403).json({ error: "NOT_AUTHORIZED" })
    }

    const otpRecord = await prisma.otpCode.findFirst({
      where: { customerId: customer.id }
    })

    if (!otpRecord || otpRecord.expiresAt < new Date()) {
      return res.status(400).json({ error: "OTP invalid or expired" })
    }

    const hashedInput = crypto.createHash("sha256").update(otp).digest("hex")

    if (hashedInput !== otpRecord.code) {
      return res.status(400).json({ error: "Invalid OTP" })
    }

    await prisma.otpCode.deleteMany({
      where: { customerId: customer.id }
    })

    const now = new Date()

    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    const absoluteExpiresAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000)

    const newSession = await prisma.customerSession.create({
      data: {
        customerId: customer.id,
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

    return res.json({ message: "Authenticated" })

  } catch (error) {
    console.error("VERIFY ERROR:", error)
    return res.status(500).json({ error: "Server error" })
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

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})