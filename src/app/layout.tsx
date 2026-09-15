import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_TC, Syne } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const noto = Noto_Sans_TC({
  variable: "--font-noto",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  weight: ["700", "800"],
});

export const metadata: Metadata = {
  title: "SlateCrew 開麥拉組",
  description:
    "交付級開源影片 agent team：U1.5 生圖、H3 生片、SenseVoice 聲檢、Qwen 27B 畫檢、Blender 走位。CLI + Web GUI。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-Hant"
      className={`dark ${geistSans.variable} ${geistMono.variable} ${noto.variable} ${syne.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
