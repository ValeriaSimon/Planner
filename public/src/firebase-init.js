// Single Firebase boot, replacing the same inline <script type="module">
// block that used to be duplicated in index.html/today.html/tomorrow.html.
// Everything here now loads as real ES modules, so auth.js/firebase-sync.js
// import straight from the Firebase CDN instead of going through a
// window.firebaseServices bridge.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDW5xBcbpHzWrFpO8LDA4vVt8qeenGqosw",
  authDomain: "planner-bdd6f.firebaseapp.com",
  projectId: "planner-bdd6f",
  storageBucket: "planner-bdd6f.firebasestorage.app",
  messagingSenderId: "575920639228",
  appId: "1:575920639228:web:10b3f9250d861086639b79",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
