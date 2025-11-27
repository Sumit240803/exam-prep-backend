const Razorpay = require("razorpay");
const express = require("express");
const cors = require("cors");
const { validateWebhookSignature } = require("razorpay/dist/utils/razorpay-utils");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*",
  })
);

const supabase = require("@supabase/supabase-js");
const supabaseClient = supabase.createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --------------------------------------------------
// CREATE ORDER
// --------------------------------------------------
app.post("/create-order", async (req, res) => {
  try {
    const { amount, user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
      notes: {
        user_id: user_id, // IMPORTANT — used in webhook
      },
    });
   await supabaseClient
      .from("payments")
      .update({ order_id: order.id })
      .eq("user_id", user_id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    return res.status(201).json(order);
  } catch (error) {
    console.error("❌ Error creating order:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// --------------------------------------------------
// RAZORPAY WEBHOOK — main truth source
// --------------------------------------------------
app.post("/razorpay-webhook", async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const payload = JSON.stringify(req.body);
    const receivedSignature = req.headers["x-razorpay-signature"];

    // Verify Razorpay webhook signature
    const isValid = validateWebhookSignature(payload, receivedSignature, secret);

    if (!isValid) {
      console.log("❌ Invalid webhook signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = req.body.event;

    if (event === "payment.captured") {
      const paymentId = req.body.payload.payment.entity.id;
      const payment = req.body.payload.payment.entity;
      const userId = payment.notes.user_id;

      console.log("🎉 Payment captured for user:", userId);
      await supabaseClient
        .from("payments")
        .update({
          status: "completed",
          razorpay_payment_id: paymentId,
        })
        .eq("order_id", payment.order_id)
        .eq("status", "pending");


      // Update only the profiles table
      await supabaseClient
        .from("profiles")
        .update({ payment_status: "completed" })
        .eq("user_id", userId);

      return res.status(200).json({ status: "success" });
    }

    return res.status(200).json({ status: "ignored" });
  } catch (error) {
    console.error("❌ Webhook processing failed:", error);
    return res.status(500).json({ error: "Webhook processing error" });
  }
});

// --------------------------------------------------
app.listen(3000, () => {
  console.log("🚀 Backend running on port 3000");
});
