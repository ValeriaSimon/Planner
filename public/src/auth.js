// Household sign-in (single shared password), sign-out button, and
// sign-in-state routing between index.html and the day pages.

import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { auth } from "./firebase-init.js";
import { startFirebaseSync } from "./firebase-sync.js";

// Single shared household account. Both people sign in with the same
// password; this email is just an identifier Firebase Auth requires, never
// shown in the UI.
const HOUSEHOLD_EMAIL = "bebii@home.com";

export function wireAuth() {
  const bar = Object.assign(document.createElement("div"), { style: "position:fixed;top:8px;right:8px;z-index:9999" });
  const signOutBtn = Object.assign(document.createElement("button"), { textContent: "Sign out", style: "display:none" });
  bar.append(signOutBtn);
  document.body.append(bar);
  signOutBtn.onclick = () => signOut(auth);

  document.getElementById("household-signin-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwInput = document.getElementById("household-password");
    const password = pwInput?.value || "";
    if (!password) return;
    try {
      await signInWithEmailAndPassword(auth, HOUSEHOLD_EMAIL, password);
    } catch {
      alert("Wrong password.");
      if (pwInput) { pwInput.value = ""; pwInput.focus(); }
    }
  });

  onAuthStateChanged(auth, (u) => {
    signOutBtn.style.display = u ? "" : "none";

    const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    const onLanding = here === "index.html";

    if (u && onLanding) location.replace("./today.html");
    if (!u && !onLanding) location.replace("./index.html");

    if (u) startFirebaseSync(u);
  });
}
