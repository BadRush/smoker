import type { Metadata } from "next";
import "./globals.css";
import "uplot/dist/uPlot.min.css";

export const metadata: Metadata = {
  title: "Smoker — Distributed Latency & NOC Observability",
  description:
    "Real-time distributed SmokePing, zero-gap Metro store-and-forward probing, and multi-probe quorum alerting.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-canvas text-zinc-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
        {children}
      </body>
    </html>
  );
}
