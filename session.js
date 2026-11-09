// One login for the whole site. Every page loads this: it starts Firebase once and keeps the
// top bar's Log in / Log out button right. Signing in on any page signs you in everywhere.
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

const here = () => location.pathname.split("/").pop() || "./";
export const loginLink = (next) => "login.html?next=" + encodeURIComponent(next || here());
export const logOut = () => auth ? signOut(auth) : Promise.resolve();

const btn = document.getElementById("navAuth");
function paint(user) {
  if (!btn) return;
  btn.classList.toggle("out", !!user);
  if (user) {
    btn.textContent = "Log out";
    btn.title = user.email || "";
    btn.href = "#";
    btn.onclick = (e) => { e.preventDefault(); logOut(); };
  } else {
    btn.textContent = "Log in";
    btn.removeAttribute("title");
    btn.href = here() === "login.html" ? "login.html" : loginLink();
    btn.onclick = null;
  }
}
paint(null);
if (auth) onAuthStateChanged(auth, paint);
