// One login for the whole site. Every page loads this: it starts Firebase once, keeps the top bar's
// Log out button working, and on signed-in pages (<body data-gate>) sends anyone not logged in to the
// login screen first. If accounts aren't switched on yet, nothing is locked.
import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

export let app = null, auth = null;
try {
  if (firebaseConfig && firebaseConfig.apiKey && !/PASTE/.test(firebaseConfig.apiKey)) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
  }
} catch (e) { console.error(e); }

const page = () => location.pathname.split("/").pop() || "index.html";
const gated = document.body.hasAttribute("data-gate");
export const logOut = () => (auth ? signOut(auth) : Promise.resolve()).then(() => location.replace("./"));

// The top-bar button: "Log out" when signed in, "Log in" when not (the Record page is open to everyone)
const btn = document.getElementById("navAuth");

// Testing tab (admin only). Shows when you're logged in with the admin email (set in .env as ADMIN_EMAIL,
// published only as a scrambled fingerprint in admin.json), or on a device where you've unlocked testing.html.
const nav = document.querySelector(".sitenav .in");
function addTesting() {
  if (!nav || !nav.querySelector(".tab") || nav.querySelector('a[href="testing.html"]')) return;
  const a = document.createElement("a");
  a.className = "tab"; a.href = "testing.html"; a.textContent = "Testing"; a.title = "Admin only";
  nav.insertBefore(a, btn && btn.parentNode === nav ? btn : null);
  try { localStorage.setItem("bb_tester", "1"); } catch (e) {}
}
try { if (localStorage.getItem("bb_tester") === "1") addTesting(); } catch (e) { /* storage blocked */ }
async function checkAdmin(user) {
  if (!user || !user.email || !nav) return;
  try {
    const f = await (await fetch("admin.json", { cache: "no-store" })).json();
    if (!f.h) return;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bookbuster:" + user.email.trim().toLowerCase()));
    const h = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (h === f.h) addTesting();
  } catch (e) { /* no admin file yet */ }
}
// on a phone, keep the page you're on in view in the sliding top bar
const cur = nav && nav.querySelector('[aria-current="page"]');
if (cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, cur.offsetLeft - 60);
function paint(user) {
  if (!btn) return;
  btn.classList.toggle("out", !!user);
  btn.textContent = user ? "Log out" : "Log in";
  btn.title = user ? (user.email || "") : "";
  btn.href = user ? "#" : "./?next=bankroll.html";
  btn.onclick = user ? (e) => { e.preventDefault(); logOut(); } : null;
}

if (!auth) {
  document.body.classList.add("ok");                      // accounts not switched on yet: show the page
  if (btn) btn.hidden = true;
} else {
  onAuthStateChanged(auth, (user) => {
    if (!user && gated) { location.replace("./?next=" + encodeURIComponent(page())); return; }
    paint(user);
    checkAdmin(user);
    document.body.classList.add("ok");
  });
}
