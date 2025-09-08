import express from "express";
import nodemailer from "nodemailer";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { getDatabase } from "firebase-admin/database"; // Use getDatabase

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://server-dmx8.onrender.com', // Replace with your actual Render frontend URL
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Firebase Admin setup
const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://inventorymanagementsyste-23fed-default-rtdb.firebaseio.com",
});

const db = getDatabase(); // Initialize Realtime Database

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  logger: true,
  debug: true,
});

// Verify Nodemailer setup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Nodemailer error:", error.message);
  } else {
    console.log("✅ Nodemailer transporter ready");
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ Backend is running!");
});

// Test email
app.get("/test-email", async (req, res) => {
  const mailOptions = {
    from: `"InventoryMW" <${process.env.EMAIL_USER}>`,
    to: "test@example.com",
    subject: "Test Email from InventoryMW",
    text: "This is a test email to verify Nodemailer configuration.",
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "✅ Test email sent successfully" });
  } catch (error) {
    console.error("❌ Test email error:", error.message);
    res.status(500).json({ message: "❌ Failed to send test email", error: error.message });
  }
});

// Send email notification
app.post("/api/send-email-notification", async (req, res) => {
  const { userId, userEmail, saleData, cartItems, totalAmount } = req.body;

  if (!userId || !userEmail || !saleData || !cartItems || !totalAmount) {
    console.error("Missing required fields", req.body);
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const userRecord = await admin.auth().getUser(userId);
    if (userRecord.email !== userEmail) {
      console.error("Email mismatch", { userId, userEmail, authEmail: userRecord.email });
      return res.status(400).json({ message: "Email does not match user ID" });
    }
  } catch (error) {
    console.error("Error verifying user", error.message);
    return res.status(400).json({ message: "Invalid user ID", error: error.message });
  }

  const emailSubject = `New Sale Completed - ${saleData.Saledate}`;
  let emailBody = `
    <h2>Sale Notification</h2>
    <p>Dear User,</p>
    <p>A new sale has been completed in your inventory system.</p>
    <p><strong>Sale ID:</strong> ${saleData.Sale_id}</p>
    <p><strong>Date:</strong> ${saleData.Saledate}</p>
    <p><strong>Total Amount:</strong> MK ${totalAmount.toLocaleString()}</p>
    <h3>Items Sold:</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead>
        <tr style="background-color: #f2f2f2;">
          <th>Item Name</th>
          <th>Quantity</th>
          <th>Price</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
  `;

  cartItems.forEach((item) => {
    emailBody += `
      <tr>
        <td>${item.item_name}</td>
        <td>${item.quantity}</td>
        <td>MK ${item.price.toLocaleString()}</td>
        <td>MK ${item.total.toLocaleString()}</td>
      </tr>
    `;
  });

  emailBody += `
      </tbody>
    </table>
    <p>Thank you for using InventoryMW.</p>
    <p><em>This is an automated notification. Please do not reply.</em></p>
  `;

  const mailOptions = {
    from: `"InventoryMW" <${process.env.EMAIL_USER}>`,
    to: userEmail,
    subject: emailSubject,
    html: emailBody,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent for sale:", saleData.Sale_id);
    res.status(200).json({ message: "✅ Email notification sent successfully" });
  } catch (error) {
    console.error("❌ Email error:", error.message);
    res.status(500).json({ message: "❌ Failed to send email", error: error.message });
  }
});

// Payment callback from PayChangu
app.get("/payment-callback", async (req, res) => {
  const { status, tx_ref, userId } = req.query;

  console.log("Payment callback received:", { status, tx_ref, userId });

  if (!status || !tx_ref || !userId) {
    console.error("Missing callback parameters", req.query);
    return res.redirect("https://server-dmx8.onrender.com/subscribe?status=failed");
  }

  if (status !== "success") {
    console.error("Payment failed in callback", { tx_ref, status });
    return res.redirect("https://server-dmx8.onrender.com/subscribe?status=failed");
  }

  try {
    const response = await axios.get(`https://api.paychangu.com/verify-payment/${tx_ref}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
      },
    });

    console.log("PayChangu verification response:", response.data);

    const paymentData = response.data.data;
    if (paymentData.status !== "success") {
      console.error("Payment verification failed", { tx_ref, paymentData });
      return res.redirect("https://server-dmx8.onrender.com/subscribe?status=failed");
    }

    try {
      await admin.auth().getUser(userId);
      console.log("User verified:", userId);
    } catch (error) {
      console.error("Invalid user ID in payment callback", { userId, error: error.message });
      return res.redirect("https://server-dmx8.onrender.com/subscribe?status=failed");
    }

    const subscriptionRef = db.ref(`users/${userId}/subscriptionEndDate`);
    const currentDate = new Date();
    currentDate.setMonth(currentDate.getMonth() + 1);
    const subscriptionEndDate = currentDate.toISOString().split("T")[0];

    await subscriptionRef.set(subscriptionEndDate);
    console.log("Subscription updated:", { userId, subscriptionEndDate });

    const subscriptionsRef = db.ref(`users/${userId}/subscriptions`);
    const newSubscriptionRef = subscriptionsRef.push(); // Use push as a method
    await newSubscriptionRef.set({
      tx_ref,
      amount: 15000,
      currency: "MWK",
      paymentDate: new Date().toISOString(),
      subscriptionEndDate,
      status: "success",
    });
    console.log("Subscription history recorded:", { userId, tx_ref });

    res.redirect("https://server-dmx8.onrender.com/dashboard");
  } catch (error) {
    console.error("Error verifying payment:", {
      message: error.message,
      response: error.response?.data,
    });
    res.redirect("https://server-dmx8.onrender.com/subscribe?status=failed");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});