import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FOMO KOL Monitor",
  description: "Monitor FOMO-linked Solana and EVM wallets in real time.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
