import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DislikeFeedbackProvider } from "./DislikeFeedback";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DislikeFeedbackProvider>
      <App />
    </DislikeFeedbackProvider>
  </React.StrictMode>,
);
