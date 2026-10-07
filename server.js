require("dotenv").config();
const express=require("express"),path=require("path"),bcrypt=require("bcryptjs"),cookieSession=require("cookie-session");
const {createClient}=require("@supabase/supabase-js");
const app=express(),PORT=process.env.PORT||3000;
// Render terminates HTTPS at its proxy. Trust that proxy so secure session cookies are preserved.
app.set("trust proxy",1);
const SUBSCRIPTION_AMOUNT=Number(process.env.SUBSCRIPTION_AMOUNT||50);
const SUBSCRIPTION_MONTHS=Number(process.env.SUBSCRIPTION_MONTHS||2);
const rawSupabaseUrl=String(process.env.SUPABASE_URL||"").trim();
const supabaseUrl=rawSupabaseUrl
  .replace(/\/rest\/v1\/?$/i,"")
  .replace(/\/+$/,"");
const supabaseKey=String(process.env.SUPABASE_SERVICE_ROLE_KEY||"").trim();
const supabaseConfigured=Boolean(supabaseUrl&&supabaseKey);
console.log("Supabase configuration check:", {
  urlPresent: Boolean(supabaseUrl),
  keyPresent: Boolean(supabaseKey),
  urlHost: (()=>{ try { return supabaseUrl ? new URL(supabaseUrl).host : null; } catch { return "invalid-url"; } })()
});
if(!supabaseConfigured){
  console.error("Supabase is not available to this running process. SUPABASE_URL present:", Boolean(supabaseUrl), "SUPABASE_SERVICE_ROLE_KEY present:", Boolean(supabaseKey));
}
const supabase=supabaseConfigured?createClient(supabaseUrl,supabaseKey):null;
const requireSupabase=(_,res,next)=>{
  if(!supabaseConfigured)return res.status(503).json({error:"Supabase is not configured on this Render service. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render → Environment, then redeploy."});
  next();
};
app.use(express.json());app.use(express.urlencoded({extended:true}));
app.use(cookieSession({name:"trs_session",keys:[process.env.SESSION_SECRET||"change-me"],httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:604800000}));
app.use(express.static(path.join(__dirname,"public"), {
  setHeaders(res, filePath) {
    if(filePath.endsWith("/app.js")) res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
  }
}));
const requireUser=(req,res,next)=>req.session?.user?next():res.status(401).json({error:"Please create an account or sign in."});
const requireAdmin=(req,res,next)=>req.session?.user?.is_admin?next():res.status(403).json({error:"Admin access only."});
async function byEmail(email){const {data,error}=await supabase.from("users").select("*").eq("email",String(email).toLowerCase()).maybeSingle();if(error)throw error;return data;}
async function addUserSession(req,u){const now=new Date().toISOString();const {data:membership}=await supabase.from("support_payments").select("id,status,expires_at").eq("user_id",u.id).eq("type","subscription").eq("status","successful").gt("expires_at",now).order("expires_at",{ascending:false}).limit(1).maybeSingle();req.session.user={id:u.id,email:u.email,name:u.name,is_admin:u.is_admin,subscribed:!!membership,subscription_expires_at:membership?.expires_at||null};}
app.get("/health",(_,res)=>res.json({
  ok:true,
  site:"Thane Rivers Community",
  supabase_configured:supabaseConfigured,
  supabase_url_present:Boolean(supabaseUrl),
  supabase_key_present:Boolean(supabaseKey)
}));
app.get("/api/config",(_,res)=>res.json({subscription_amount:SUBSCRIPTION_AMOUNT,subscription_months:SUBSCRIPTION_MONTHS,currency:process.env.FLW_CURRENCY||"USD"}));
app.get("/api/me",requireSupabase,async(req,res)=>{if(!req.session?.user)return res.json({user:null});const u=await byEmail(req.session.user.email);if(!u)return res.json({user:null});await addUserSession(req,u);res.json({user:req.session.user});});
app.post("/api/register",requireSupabase,async(req,res)=>{try{const name=String(req.body.name||"").trim(),email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");if(!email||!password||password.length<8)return res.status(400).json({error:"Use an email and a password of at least 8 characters."});if(await byEmail(email))return res.status(409).json({error:"An account with that email already exists."});const password_hash=await bcrypt.hash(password,12);const {data,error}=await supabase.from("users").insert({name,email,password_hash}).select("id,email,name,is_admin").single();if(error)throw error;req.session.user={...data,subscribed:false};res.json({user:req.session.user});}catch(e){console.error("Registration error:",e);res.status(500).json({error:"Could not create account."})}});
app.post("/api/login",requireSupabase,async(req,res)=>{try{const u=await byEmail(req.body.email||"");if(!u||!(await bcrypt.compare(String(req.body.password||""),u.password_hash)))return res.status(401).json({error:"Incorrect email or password."});await addUserSession(req,u);res.json({user:req.session.user});}catch(e){console.error(e);res.status(500).json({error:"Login failed."})}});
app.post("/api/logout",(req,res)=>{req.session=null;res.json({ok:true})});
const requireMember=(req,res,next)=>{if(!req.session?.user)return res.status(401).json({error:"Please create an account or sign in."});if(!req.session.user.subscribed)return res.status(403).json({error:"An active $50 subscription is required to use private chat."});next()};
app.get("/api/messages",requireSupabase,requireMember,async(req,res)=>{const {data,error}=await supabase.from("messages").select("*").eq("user_id",req.session.user.id).order("created_at",{ascending:true});if(error)return res.status(500).json({error:"Could not load your conversation."});res.json({messages:data||[]})});
app.post("/api/messages",requireSupabase,requireMember,async(req,res)=>{const body=String(req.body.body||"").trim();if(!body)return res.status(400).json({error:"Message cannot be empty."});const {data,error}=await supabase.from("messages").insert({user_id:req.session.user.id,sender_role:"customer",body}).select("*").single();if(error)return res.status(500).json({error:"Could not send message."});res.json({message:data})});
app.get("/api/admin/messages",requireSupabase,requireAdmin,async(req,res)=>{const {data,error}=await supabase.from("messages").select("*,users!messages_user_id_fkey(name,email)").order("created_at",{ascending:true});if(error)return res.status(500).json({error:"Could not load community messages."});res.json({messages:data||[]})});
app.post("/api/admin/messages",requireSupabase,requireAdmin,async(req,res)=>{const userId=String(req.body.user_id||"");const body=String(req.body.body||"").trim();if(!userId||!body)return res.status(400).json({error:"User and message are required."});const {data,error}=await supabase.from("messages").insert({user_id:userId,sender_role:"admin",body}).select("*").single();if(error)return res.status(500).json({error:"Could not send admin message."});res.json({message:data})});
app.post("/api/flutterwave/checkout",requireSupabase,async(req,res)=>{try{const type=String(req.body.type||"");let amount;let userId=null;let email=String(req.body.email||"").trim().toLowerCase();let name=String(req.body.name||"").trim();if(req.session?.user){userId=req.session.user.id;email=req.session.user.email;name=req.session.user.name||name}if(type==="subscription"){if(!userId)return res.status(401).json({error:"Create an account or sign in before subscribing."});amount=SUBSCRIPTION_AMOUNT}else if(type==="donation"){amount=Number(req.body.amount)}else return res.status(400).json({error:"Invalid payment type."});if(!Number.isFinite(amount)||amount<1)return res.status(400).json({error:"Enter a valid amount."});const tx_ref=`TRV-${type.toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;const {data:payment,error:pe}=await supabase.from("support_payments").insert({user_id:userId,customer_email:email||null,amount,type,status:"pending",payment_reference:tx_ref}).select("*").single();if(pe)throw pe;const base=process.env.BASE_URL||`https://${req.get("host")}`;const currency=process.env.FLW_CURRENCY||"USD";const response=await fetch("https://api.flutterwave.com/v3/payments",{method:"POST",headers:{Authorization:`Bearer ${process.env.FLW_SECRET_KEY||""}`,"Content-Type":"application/json"},body:JSON.stringify({amount,currency,tx_ref,redirect_url:`${base}/flutterwave/callback`,customer:{email:email||undefined,name:name||"Thane Rivers supporter"},customizations:{title:type==="subscription"?"Thane Rivers Community Subscription":"Support Thane Rivers",description:type==="subscription"?"Two months of Thane Rivers community access":"Donation to Thane Rivers"},meta:{support_payment_id:payment.id,type}})});const out=await response.json();if(!response.ok||out.status!=="success")throw new Error(out.message||"Flutterwave checkout could not be created.");res.json({link:out.data.link});}catch(e){console.error(e);res.status(500).json({error:"Could not start Flutterwave checkout. Check FLW_SECRET_KEY and FLW_CURRENCY on Render."})}});
app.get("/flutterwave/callback", requireSupabase, async (req, res) => {
  try {
    const txRef = String(req.query.tx_ref || "").trim();
    if (!txRef) return res.redirect("/?payment=failed");

    const verifyUrl = "https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=" + encodeURIComponent(txRef);
    const response = await fetch(verifyUrl, {
      headers: {
        Authorization: "Bearer " + (process.env.FLW_SECRET_KEY || ""),
        "Content-Type": "application/json"
      }
    });
    const out = await response.json();
    const successful = out.status === "success" && out.data && out.data.status === "successful";
    const status = successful ? "successful" : "failed";

    const { data: payment, error: paymentError } = await supabase
      .from("support_payments")
      .select("id,type,user_id,amount,status")
      .eq("payment_reference", txRef)
      .maybeSingle();

    if (paymentError) throw paymentError;

    if (payment) {
      if (successful && payment.type === "subscription") {
        const expires = new Date();
        expires.setMonth(expires.getMonth() + SUBSCRIPTION_MONTHS);
        await supabase
          .from("support_payments")
          .update({ status: "successful", expires_at: expires.toISOString() })
          .eq("id", payment.id);
      } else {
        await supabase
          .from("support_payments")
          .update({ status: status })
          .eq("id", payment.id);
      }
    }

    res.redirect("/?payment=" + status);
  } catch (e) {
    console.error("Flutterwave verification error:", e);
    res.redirect("/?payment=failed");
  }
});
app.get("/api/admin/members",requireSupabase,requireAdmin,async(_,res)=>{const {data,error}=await supabase.from("users").select("id,name,email,is_admin,created_at").order("created_at",{ascending:false});if(error)return res.status(500).json({error:"Could not load members."});res.json({members:data||[]})});
app.get("/admin",requireAdmin,(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.use((req,res,next)=>{if(req.method==="GET"&&req.accepts("html"))return res.sendFile(path.join(__dirname,"public","index.html"));next();});
app.listen(PORT,()=>console.log(`Thane Rivers Community running on ${PORT}`));
