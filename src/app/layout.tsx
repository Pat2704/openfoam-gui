import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import ChatPopup from "@/components/chat-popup";
import { CaseProvider } from "@/lib/case-context";
import { ThemeProvider } from "next-themes";
import { ConfirmHost } from "@/components/ui/confirm-host";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// NOTE: `title` is authoritative for the native Electron window title —
// electron/main.js sets the same string as the BrowserWindow title and
// electron/preload.js deliberately never touches document.title.
// Keep it in sync with APP_TITLE in electron/main.js.
export const metadata: Metadata = {
  title: "OpenFOAM Studio - GUI",
  description: "Graphical interface for OpenFOAM via WSL2 on Windows. Manage cases, configure CFD simulations, run commands and monitor results.",
  keywords: ["OpenFOAM", "CFD", "WSL2", "Windows", "GUI", "fluid dynamics"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
        <CaseProvider>
          {children}
          <Toaster />
          <ChatPopup />
          <ConfirmHost />
        </CaseProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
