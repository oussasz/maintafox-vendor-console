import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { ThemeProvider } from "@/components/ui/ThemeProvider";
import { initI18n } from "@/i18n/config";
import { router } from "@/router";

import "@/styles/globals.css";

initI18n();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider
        router={router}
        future={{
          v7_startTransition: true,
        }}
      />
    </ThemeProvider>
  </StrictMode>,
);
