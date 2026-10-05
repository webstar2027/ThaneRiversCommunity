require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const cookieSession = require("cookie-session");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Supabase ---------- */
/* Normalize the URL in case /rest/v1 was accidentally included. */
const rawSupabaseUrl = String(process.env.SUPABASE_URL || "").trim();

const SUPABASE_URL = rawSupabaseUrl
  .replace(/\/+$/, "")
  .replace(/\/rest\/v1$/, "");

const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/* ---------- Middleware ---------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  cookieSession({
    name: "trs_session",
    keys: [process.env.SESSION_SECRET || "change-me"],
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 604800000
  })
);

app.use(express.static(path.join(__dirname, "public")));

/* ---------- Helpers ---------- */

const requireUser = (req, res, next) => {
  if (req.session?.user) return next();

  return res.status(401).json({
    error: "Please create an account or sign in."
  });
};

const requireAdmin = (req, res, next) => {
  if (req.session?.user?.is_admin) return next();

  return res.status(403).json({
    error: "Admin access only."
  });
};

async function byEmail(email) {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (!normalizedEmail) return null;

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function activeSubscriptionForUser(userId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("support_payments")
    .select(
      "id,status,expires_at,amount,payment_reference"
    )
    .eq("user_id", userId)
    .eq("type", "subscription")
    .eq("status", "successful")
    .gt("expires_at", now)
    .order("expires_at", {
      ascending: false
    })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function activeSubscriptionForEmail(email) {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (!normalizedEmail) return null;

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("support_payments")
    .select(
      "id,status,expires_at,amount,payment_reference,user_id,customer_email"
    )
    .eq("customer_email", normalizedEmail)
    .eq("type", "subscription")
    .eq("status", "successful")
    .gt("expires_at", now)
    .order("expires_at", {
      ascending: false
    })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function addUserSession(req, user) {
  const membership =
    await activeSubscriptionForUser(user.id);

  req.session.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    is_admin: !!user.is_admin,
    subscribed: !!membership,
    subscription_expires_at:
      membership?.expires_at || null
  };
}

/* ---------- Health ---------- */

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    site: "Thane Rivers Community"
  });
});

/* ---------- Current User ---------- */

app.get("/api/me", async (req, res) => {
  try {
    if (!req.session?.user) {
      return res.json({
        user: null
      });
    }

    const user = await byEmail(
      req.session.user.email
    );

    if (!user) {
      req.session = null;

      return res.json({
        user: null
      });
    }

    await addUserSession(req, user);

    return res.json({
      user: req.session.user
    });
  } catch (e) {
    console.error("API /api/me error:", e);

    return res.status(500).json({
      error: "Could not load account."
    });
  }
});

/* ---------- Registration ---------- */
/*
   A visitor can pay the $15 subscription BEFORE creating
   an account.

   When they later register using the same email address,
   the successful subscription is connected to that account.
*/

app.post("/api/register", async (req, res) => {
  try {
    const name = String(
      req.body.name || ""
    ).trim();

    const email = String(
      req.body.email || ""
    )
      .trim()
      .toLowerCase();

    const password = String(
      req.body.password || ""
    );

    if (
      !email ||
      !password ||
      password.length < 8
    ) {
      return res.status(400).json({
        error:
          "Use an email and a password of at least 8 characters."
      });
    }

    if (await byEmail(email)) {
      return res.status(409).json({
        error:
          "An account with that email already exists."
      });
    }

    const password_hash =
      await bcrypt.hash(password, 12);

    const { data, error } = await supabase
      .from("users")
      .insert({
        name,
        email,
        password_hash
      })
      .select(
        "id,email,name,is_admin"
      )
      .single();

    if (error) throw error;

    /*
      If the visitor already paid the $15 subscription
      using this email, attach that payment to the new
      account.
    */

    const paidSubscription =
      await activeSubscriptionForEmail(email);

    if (
      paidSubscription &&
      !paidSubscription.user_id
    ) {
      const { error: linkError } =
        await supabase
          .from("support_payments")
          .update({
            user_id: data.id
          })
          .eq(
            "id",
            paidSubscription.id
          );

      if (linkError) {
        console.error(
          "Could not link subscription to new user:",
          linkError
        );
      }
    }

    await addUserSession(req, data);

    return res.json({
      user: req.session.user
    });
  } catch (e) {
    console.error(
      "Registration error:",
      e
    );

    return res.status(500).json({
      error: "Could not create account."
    });
  }
});

/* ---------- Login ---------- */

app.post("/api/login", async (req, res) => {
  try {
    const u = await byEmail(
      req.body.email || ""
    );

    if (
      !u ||
      !(await bcrypt.compare(
        String(
          req.body.password || ""
        ),
        u.password_hash
      ))
    ) {
      return res.status(401).json({
        error:
          "Incorrect email or password."
      });
    }

    await addUserSession(req, u);

    return res.json({
      user: req.session.user
    });
  } catch (e) {
    console.error(
      "Login error:",
      e
    );

    return res.status(500).json({
      error: "Login failed."
    });
  }
});

/* ---------- Logout ---------- */

app.post("/api/logout", (req, res) => {
  req.session = null;

  res.json({
    ok: true
  });
});

/* ---------- Membership Guard ---------- */

const requireMember = async (
  req,
  res,
  next
) => {
  try {
    if (!req.session?.user) {
      return res.status(401).json({
        error:
          "Please create an account or sign in."
      });
    }

    const membership =
      await activeSubscriptionForUser(
        req.session.user.id
      );

    if (!membership) {
      req.session.user.subscribed = false;
      req.session.user.subscription_expires_at =
        null;

      return res.status(403).json({
        error:
          "An active $15 subscription is required to use private chat."
      });
    }

    req.session.user.subscribed = true;

    req.session.user.subscription_expires_at =
      membership.expires_at;

    next();
  } catch (e) {
    console.error(
      "Membership check error:",
      e
    );

    return res.status(500).json({
      error:
        "Could not verify your membership."
    });
  }
};

/* ---------- Member Messages ---------- */

app.get(
  "/api/messages",
  requireMember,
  async (req, res) => {
    try {
      const { data, error } =
        await supabase
          .from("messages")
          .select("*")
          .eq(
            "user_id",
            req.session.user.id
          )
          .order("created_at", {
            ascending: true
          });

      if (error) throw error;

      res.json({
        messages: data || []
      });
    } catch (e) {
      console.error(
        "Load messages error:",
        e
      );

      res.status(500).json({
        error:
          "Could not load your conversation."
      });
    }
  }
);

app.post(
  "/api/messages",
  requireMember,
  async (req, res) => {
    try {
      const body = String(
        req.body.body || ""
      ).trim();

      if (!body) {
        return res.status(400).json({
          error:
            "Message cannot be empty."
        });
      }

      const { data, error } =
        await supabase
          .from("messages")
          .insert({
            user_id:
              req.session.user.id,
            sender_role:
              "customer",
            body
          })
          .select("*")
          .single();

      if (error) throw error;

      res.json({
        message: data
      });
    } catch (e) {
      console.error(
        "Send message error:",
        e
      );

      res.status(500).json({
        error:
          "Could not send message."
      });
    }
  }
);

/* ---------- Admin Messages ---------- */

app.get(
  "/api/admin/messages",
  requireAdmin,
  async (req, res) => {
    try {
      const { data, error } =
        await supabase
          .from("messages")
          .select(
            "*,users!messages_user_id_fkey(name,email)"
          )
          .order("created_at", {
            ascending: true
          });

      if (error) throw error;

      res.json({
        messages: data || []
      });
    } catch (e) {
      console.error(
        "Admin messages error:",
        e
      );

      res.status(500).json({
        error:
          "Could not load community messages."
      });
    }
  }
);

app.post(
  "/api/admin/messages",
  requireAdmin,
  async (req, res) => {
    try {
      const userId = String(
        req.body.user_id || ""
      );

      const body = String(
        req.body.body || ""
      ).trim();

      if (!userId || !body) {
        return res.status(400).json({
          error:
            "User and message are required."
        });
      }

      const { data, error } =
        await supabase
          .from("messages")
          .insert({
            user_id: userId,
            sender_role: "admin",
            body
          })
          .select("*")
          .single();

      if (error) throw error;

      res.json({
        message: data
      });
    } catch (e) {
      console.error(
        "Admin send message error:",
        e
      );

      res.status(500).json({
        error:
          "Could not send admin message."
      });
    }
  }
);

/* ---------- Flutterwave Checkout ---------- */

app.post(
  "/api/flutterwave/checkout",
  async (req, res) => {
    try {
      const type = String(
        req.body.type || ""
      ).trim();

      let amount;
      let userId = null;

      let email = String(
        req.body.email || ""
      )
        .trim()
        .toLowerCase();

      let name = String(
        req.body.name || ""
      ).trim();

      if (req.session?.user) {
        userId =
          req.session.user.id;

        email =
          req.session.user.email;

        name =
          req.session.user.name ||
          name;
      }

      /*
        SUBSCRIPTION:
        $15 for two months.
        Account creation is NOT required before payment.
      */

      if (type === "subscription") {
        amount = 15;

        if (!email) {
          return res.status(400).json({
            error:
              "Enter your email before subscribing."
          });
        }
      }

      /*
        DONATION:
        Visitor chooses any amount.
      */

      else if (type === "donation") {
        amount = Number(
          req.body.amount
        );

        if (
          !Number.isFinite(amount) ||
          amount < 1
        ) {
          return res.status(400).json({
            error:
              "Enter a valid donation amount."
          });
        }
      }

      else {
        return res.status(400).json({
          error:
            "Invalid payment type."
        });
      }

      if (
        !Number.isFinite(amount) ||
        amount < 1
      ) {
        return res.status(400).json({
          error:
            "Enter a valid amount."
        });
      }

      const tx_ref =
        ⁠ TRV-${type.toUpperCase()}-${Date.now()}- ⁠ +
        Math.random()
          .toString(36)
          .slice(2, 8);

      const {
        data: payment,
        error: paymentError
      } = await supabase
        .from("support_payments")
        .insert({
          user_id: userId,
          customer_email:
            email || null,
          amount,
          type,
          status: "pending",
          payment_reference:
            tx_ref
        })
        .select("*")
        .single();

      if (paymentError) {
        throw paymentError;
      }

      const base =
        process.env.BASE_URL ||
        ⁠ https://${req.get("host")} ⁠;

      const currency =
        process.env.FLW_CURRENCY ||
        "USD";

      const response =
        await fetch(
          "https://api.flutterwave.com/v3/payments",
          {
            method: "POST",

            headers: {
              Authorization:
                ⁠ Bearer ${process.env.FLW_SECRET_KEY || ""} ⁠,
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              amount,
              currency,
              tx_ref,

              redirect_url:
                ⁠ ${base}/flutterwave/callback ⁠,

              customer: {
                email:
                  email || undefined,

                name:
                  name ||
                  "Thane Rivers supporter"
              },

              customizations: {
                title:
                  type === "subscription"
                    ? "Thane Rivers Community Subscription"
                    : "Support Thane Rivers",

                description:
                  type === "subscription"
                    ? "Two months of Thane Rivers community access"
                    : "Donation to Thane Rivers"
              },

              meta: {
                support_payment_id:
                  payment.id,

                type
              }
            })
          }
        );

      const out =
        await response.json();

      if (
        !response.ok ||
        out.status !== "success"
      ) {
        console.error(
          "Flutterwave checkout response:",
          out
        );

        throw new Error(
          out.message ||
            "Flutterwave checkout could not be created."
        );
      }

      res.json({
        link: out.data.link
      });
    } catch (e) {
      console.error(
        "Flutterwave checkout error:",
        e
      );

      res.status(500).json({
        error:
          "Could not start Flutterwave checkout. Check FLW_SECRET_KEY and FLW_CURRENCY on Render."
      });
    }
  }
);

/* ---------- Flutterwave Callback ---------- */

app.get(
  "/flutterwave/callback",
  async (req, res) => {
    try {
      const txRef = String(
        req.query.tx_ref || ""
      ).trim();

      if (!txRef) {
        return res.redirect(
          "/?payment=failed"
        );
      }

      const verifyUrl =
        "https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=" +
        encodeURIComponent(txRef);

      const response =
        await fetch(verifyUrl, {
          headers: {
            Authorization:
              "Bearer " +
              (process.env.FLW_SECRET_KEY ||
                ""),

            "Content-Type":
              "application/json"
          }
        });

      const out =
        await response.json();

      const successful =
        out.status === "success" &&
        out.data &&
        out.data.status ===
          "successful";

      const status =
        successful
          ? "successful"
          : "failed";

      const {
        data: payment,
        error: paymentError
      } = await supabase
        .from("support_payments")
        .select(
          "id,type,user_id,amount,status,customer_email"
        )
        .eq(
          "payment_reference",
          txRef
        )
        .maybeSingle();

      if (paymentError) {
        throw paymentError;
      }

      if (payment) {
        if (
          successful &&
          payment.type ===
            "subscription"
        ) {
          const expires =
            new Date();

          expires.setMonth(
            expires.getMonth() + 2
          );

          const {
            error: updateError
          } = await supabase
            .from("support_payments")
            .update({
              status:
                "successful",

              expires_at:
                expires.toISOString()
            })
            .eq(
              "id",
              payment.id
            );

          if (updateError) {
            throw updateError;
          }
        } else {
          const {
            error: updateError
          } = await supabase
            .from("support_payments")
            .update({
              status
            })
            .eq(
              "id",
              payment.id
            );

          if (updateError) {
            throw updateError;
          }
        }
      }

      return res.redirect(
        "/?payment=" + status
      );
    } catch (e) {
      console.error(
        "Flutterwave verification error:",
        e
      );

      return res.redirect(
        "/?payment=failed"
      );
    }
  }
);

/* ---------- Admin Members ---------- */

app.get(
  "/api/admin/members",
  requireAdmin,
  async (_, res) => {
    try {
      const { data, error } =
        await supabase
          .from("users")
          .select(
            "id,name,email,is_admin,created_at"
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          );

      if (error) throw error;

      res.json({
        members: data || []
      });
    } catch (e) {
      console.error(
        "Admin members error:",
        e
      );

      res.status(500).json({
        error:
          "Could not load members."
      });
    }
  }
);

/* ---------- Frontend Fallback ---------- */

app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    req.accepts("html")
  ) {
    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }

  next();
});

/* ---------- Start ---------- */

app.listen(PORT, () => {
  console.log(
    ⁠ Thane Rivers Community running on ${PORT} ⁠
  );
});
