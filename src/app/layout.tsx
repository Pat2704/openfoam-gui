import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import ChatPopup from "@/components/chat-popup";
import { CaseProvider } from "@/lib/case-context";
import { ThemeProvider } from "next-themes";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenFOAM Studio - Web GUI (WSL2)",
  description: "Web graphical interface for OpenFOAM via WSL2 on Windows. Manage cases, configure CFD simulations, run commands and monitor results.",
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
        </CaseProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
