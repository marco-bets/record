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

const btn = document.getElementById("navAuth");
if (btn) btn.onclick = (e) => { e.preventDefault(); logOut(); };

if (!auth) {
  document.body.classList.add("ok");                      // accounts not switched on yet: show the page
  if (btn) btn.hidden = true;
} else {
  onAuthStateChanged(auth, (user) => {
    if (!user && gated) { location.replace("./?next=" + encodeURIComponent(page())); return; }
    if (btn && user) btn.title = user.email || "";
    document.body.classList.add("ok");
  });
}
