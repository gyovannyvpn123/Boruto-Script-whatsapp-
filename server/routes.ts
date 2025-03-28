import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { WebSocketServer } from "ws";
import session from "express-session";
import multer from "multer";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { z } from "zod";
import { whatsAppClient } from "./whatsapp";

// Configure storage for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      const uploadDir = path.join(__dirname, "..", "uploads");
      // Create uploads directory if it doesn't exist
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + "-" + file.originalname);
    },
  }),
});

// Import and initialize memory store
import memoryStoreModule from "memorystore";
const MemoryStoreFactory = memoryStoreModule(session);

// Active sessions
const activeSessions: Record<string, {
  messages: Array<{ message: string; type: string }>;
  completed: boolean;
  isRunning: boolean;
}> = {};

export async function registerRoutes(app: Express): Promise<Server> {
  // Log environment variables for debugging (without exposing token)
  console.log('Environment check:');
  console.log('WHATSAPP_PHONE_NUMBER exists:', !!process.env.WHATSAPP_PHONE_NUMBER);
  console.log('WHATSAPP_API_TOKEN exists:', !!process.env.WHATSAPP_API_TOKEN);
  console.log('WHATSAPP_PHONE_NUMBER_ID exists:', !!process.env.WHATSAPP_PHONE_NUMBER_ID);
  
  // Health check and ping endpoints
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/ping", (req, res) => {
    res.status(200).json({ status: "ok" });
  });
  
  // Environment check endpoint for frontend
  app.get("/api/env-check", (req, res) => {
    const hasWhatsappToken = !!process.env.WHATSAPP_API_TOKEN;
    const hasPhoneNumber = !!process.env.WHATSAPP_PHONE_NUMBER;
    const hasPhoneNumberId = !!process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    // Only return if variables exist, not the actual values (for security)
    res.status(200).json({
      hasWhatsappToken,
      hasPhoneNumber,
      hasPhoneNumberId,
      // Provide phone number values for display but mask token
      phoneNumberValue: hasPhoneNumber ? process.env.WHATSAPP_PHONE_NUMBER : null,
      phoneNumberIdValue: hasPhoneNumberId ? process.env.WHATSAPP_PHONE_NUMBER_ID : null
    });
  });

  // Configure session middleware
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "whatsapp-messaging-secret",
      resave: false,
      saveUninitialized: true,
      cookie: { secure: false, maxAge: 86400000 }, // 24 hours
      store: new MemoryStoreFactory({
        checkPeriod: 86400000 // prune expired entries every 24h
      }),
    })
  );

  // WhatsApp API initialization endpoint
  app.post(
    "/api/whatsapp/initialize",
    upload.single("messageFile"),
    async (req, res) => {
      try {
        // Generate a session ID
        const sessionId = nanoid();

        // Parse request data
        const apiToken = req.body.apiToken;
        const phoneNumber = req.body.phoneNumber;
        const phoneNumberId = req.body.phoneNumberId;
        const targetType = req.body.targetType;
        const targetNumbers = req.body.targetNumbers;
        const messageInputMethod = req.body.messageInputMethod;
        const messageText = req.body.messageText;
        const messageDelay = parseInt(req.body.messageDelay) || 1500;
        const retryCount = parseInt(req.body.retryCount) || 2;

        // Use environment variables as fallback if not provided in request
        const finalApiToken = apiToken || process.env.WHATSAPP_API_TOKEN;
        const finalPhoneNumber = phoneNumber || process.env.WHATSAPP_PHONE_NUMBER;
        const finalPhoneNumberId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
        
        // Validate required fields
        if (!finalApiToken) {
          return res.status(400).json({ error: "WhatsApp API Token is required. Please provide a token or set the WHATSAPP_API_TOKEN environment variable." });
        }

        if (!finalPhoneNumber) {
          return res
            .status(400)
            .json({ error: "Phone number is required. Please provide a phone number or set the WHATSAPP_PHONE_NUMBER environment variable." });
        }
        
        if (!finalPhoneNumberId) {
          return res
            .status(400)
            .json({ error: "Phone Number ID is required for WhatsApp Business API. Please provide an ID or set the WHATSAPP_PHONE_NUMBER_ID environment variable." });
        }

        if (!targetNumbers) {
          return res
            .status(400)
            .json({ error: "Target numbers are required" });
        }

        if (
          messageInputMethod === "direct" && !messageText ||
          messageInputMethod === "file" && !req.file
        ) {
          return res
            .status(400)
            .json({ error: "Message content is required" });
        }

        // Create credentials object with token (using final token that might be from env)
        const tokenCredentials = { apiToken: finalApiToken };
        
        // Store session data
        await storage.createSession({
          id: sessionId,
          credentials: tokenCredentials,
          phoneNumber: finalPhoneNumber,
          phoneNumberId: finalPhoneNumberId,
          targetType,
          targetNumbers,
          messageInputMethod,
          messageText: messageInputMethod === "direct" ? messageText : null,
          messageFilePath:
            messageInputMethod === "file" && req.file
              ? req.file.path
              : null,
          messageDelay,
          retryCount,
          isMessaging: false,
          isConnected: false,
        });

        // Initialize WhatsApp client (using finalPhoneNumber and finalPhoneNumberId that might be from env)
        const initialized = await whatsAppClient.initialize(
          sessionId,
          tokenCredentials,
          finalPhoneNumber,
          finalPhoneNumberId
        );

        if (!initialized) {
          return res
            .status(500)
            .json({ error: "Failed to initialize WhatsApp client" });
        }

        // Store session in memory for status updates
        activeSessions[sessionId] = {
          messages: [],
          completed: false,
          isRunning: false,
        };

        // Add session ID to user session
        if (req.session) {
          // @ts-ignore - Adding custom property to session
          req.session.whatsappSessionId = sessionId;
        }

        // Add initial logs
        await storage.createMessageLog({
          sessionId,
          message: "WhatsApp client initialized successfully",
          type: "info",
        });

        activeSessions[sessionId].messages.push({
          message: "WhatsApp client initialized successfully",
          type: "info",
        });

        res.status(200).json({ sessionId });
      } catch (error) {
        console.error("Error initializing WhatsApp:", error);
        res.status(500).json({
          error: `Failed to initialize: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  );

  // Start messaging
  app.post("/api/whatsapp/start", async (req, res) => {
    try {
      // @ts-ignore - Custom property from session
      const sessionId = req.session?.whatsappSessionId;

      if (!sessionId) {
        return res.status(400).json({ error: "No active session found" });
      }

      const session = await storage.getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Set session as running
      activeSessions[sessionId].isRunning = true;

      // Start the messaging process
      whatsAppClient
        .startMessaging(
          sessionId,
          session.targetType,
          session.targetNumbers,
          session.messageInputMethod,
          session.messageText,
          session.messageFilePath,
          session.messageDelay || 1500, // Provide default if null
          session.retryCount || 2 // Provide default if null
        )
        .then((result) => {
          activeSessions[sessionId].completed = true;
          activeSessions[sessionId].isRunning = false;
        })
        .catch((error) => {
          activeSessions[sessionId].messages.push({
            message: `Error: ${error.message}`,
            type: "error",
          });
          activeSessions[sessionId].isRunning = false;
          storage.createMessageLog({
            sessionId,
            message: `Error: ${error.message}`,
            type: "error",
          });
        });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error starting messaging:", error);
      res.status(500).json({
        error: `Failed to start messaging: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  });

  // Stop messaging
  app.post("/api/whatsapp/stop", async (req, res) => {
    try {
      // @ts-ignore - Custom property from session
      const sessionId = req.session?.whatsappSessionId;

      if (!sessionId) {
        return res.status(400).json({ error: "No active session found" });
      }

      // Stop the messaging process
      await whatsAppClient.stopMessaging(sessionId);

      // Update session status
      activeSessions[sessionId].isRunning = false;

      // Log the stop event
      await storage.createMessageLog({
        sessionId,
        message: "Messaging stopped by user",
        type: "warning",
      });

      activeSessions[sessionId].messages.push({
        message: "Messaging stopped by user",
        type: "warning",
      });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error stopping messaging:", error);
      res.status(500).json({
        error: `Failed to stop messaging: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  });

  // Get messaging status
  app.get("/api/whatsapp/status", async (req, res) => {
    try {
      // @ts-ignore - Custom property from session
      const sessionId = req.session?.whatsappSessionId;

      if (!sessionId || !activeSessions[sessionId]) {
        return res.status(400).json({ error: "No active session found" });
      }

      // Get latest logs from session
      const messages = [...activeSessions[sessionId].messages];
      
      // Clear the messages queue after sending
      activeSessions[sessionId].messages = [];

      res.status(200).json({
        messages,
        completed: activeSessions[sessionId].completed,
        isRunning: activeSessions[sessionId].isRunning,
      });
    } catch (error) {
      console.error("Error getting status:", error);
      res.status(500).json({
        error: `Failed to get status: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  });

  const httpServer = createServer(app);

  // Initialize WebSocket server for real-time updates
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    console.log("WebSocket client connected");

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Handle subscribe to session events
        if (data.type === "subscribe" && data.sessionId) {
          // @ts-ignore
          ws.sessionId = data.sessionId;
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    });

    ws.on("close", () => {
      console.log("WebSocket client disconnected");
    });
  });

  // Function to broadcast message to subscribers
  whatsAppClient.setMessageCallback((sessionId, message, type) => {
    // Store message in active session
    if (activeSessions[sessionId]) {
      activeSessions[sessionId].messages.push({
        message,
        type,
      });
    }

    // Store message log in database
    storage.createMessageLog({
      sessionId,
      message,
      type,
    });

    // Broadcast message to WebSocket clients
    wss.clients.forEach((client) => {
      // @ts-ignore
      if (client.sessionId === sessionId && client.readyState === 1) {
        client.send(JSON.stringify({
          type: "log",
          message,
          logType: type,
          timestamp: new Date().toISOString(),
        }));
      }
    });
  });

  return httpServer;
}
