import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Book Your Stay — The Royal Grand Hotel",
  description:
    "Reserve your stay at The Royal Grand Hotel — live availability, best-rate guarantee, instant confirmation on WhatsApp. Powered by Velurex HMS.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#0F2622",
  width: "device-width",
  initialScale: 1,
};

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
