import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Edify CRM — Agentic",
  description: "Digital Edify Agentic CRM",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-canvas font-sans text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
