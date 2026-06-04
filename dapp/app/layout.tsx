import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "Deep Arena Mock Console",
    description: "Mock dashboard and contract adapter boundary for Deep Arena",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
