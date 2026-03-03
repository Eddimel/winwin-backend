import { prisma } from "../lib/prisma.js"

const SLIDING_DAYS = 90

export const requireAuth = async (req, res, next) => {
  try {
    const sessionId = req.cookies.session_id

    if (!sessionId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const session = await prisma.customerSession.findUnique({
      where: { id: sessionId },
      include: { customer: true }
    })

    if (!session || !session.isActive) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const now = new Date()

    // 🔒 Absolute expiration (180 jours)
    if (now > session.absoluteExpiresAt) {
      await prisma.customerSession.update({
        where: { id: session.id },
        data: { isActive: false }
      })

      res.clearCookie("session_id", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax"
      })

      return res.status(401).json({ error: "Session expired (absolute)" })
    }

    // 🔒 Sliding expiration (90 jours)
    if (now > session.expiresAt) {
      await prisma.customerSession.update({
        where: { id: session.id },
        data: { isActive: false }
      })

      res.clearCookie("session_id", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax"
      })

      return res.status(401).json({ error: "Session expired" })
    }

    // 🔄 Sliding refresh
    const newSlidingExpiration = new Date(
      now.getTime() + SLIDING_DAYS * 24 * 60 * 60 * 1000
    )

    await prisma.customerSession.update({
      where: { id: session.id },
      data: {
        lastUsedAt: now,
        expiresAt: newSlidingExpiration
      }
    })

    req.customer = session.customer
    req.session = session

    next()

  } catch (error) {
    console.error("Auth middleware error:", error)
    return res.status(500).json({ error: "Server error" })
  }
}