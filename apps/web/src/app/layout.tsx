import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClientOps Command — Demo Vertical Slice',
  description:
    'Phase 2 Deterministic ClientOps business data over Streamable HTTP MCP',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
