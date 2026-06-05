import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#0E0A14", 2: "#3B2E4A" },
        mute: "#6B5E74",
        hint: "#A89DAC",
        paper: "#FFFFFF",
        canvas: "#F4F0EA",
        warm: "#FBF7F1",
        warm2: "#F0EAE1",
        rule: "#E6DFD5",
        rule2: "#DCD3C7",
        brand: {
          blue: "#1F3FCF",
          violet: "#6B1FB8",
          magenta: "#C7197A",
          ochre: "#C69A3A",
        },
        state: {
          ok: "#2E9E6A",
          warn: "#D9534F",
          amber: "#E08A1E",
        },
      },
      fontFamily: {
        sans: ['"Inter Tight"', "system-ui", "sans-serif"],
        serif: ['"Instrument Serif"', "Georgia", "serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      backgroundImage: {
        grad: "linear-gradient(120deg,#1F3FCF 0%,#6B1FB8 52%,#C7197A 100%)",
        "grad-soft":
          "linear-gradient(120deg,rgba(31,63,207,.1),rgba(199,25,122,.08))",
        "grad-blue": "linear-gradient(135deg,#1F3FCF,#4067e6)",
        "grad-violet": "linear-gradient(135deg,#6B1FB8,#9b3fe0)",
        "grad-magenta": "linear-gradient(135deg,#C7197A,#e6479e)",
        "grad-ochre": "linear-gradient(135deg,#C69A3A,#e0b658)",
        "grad-vm": "linear-gradient(135deg,#6B1FB8,#C7197A)",
        "grad-ok": "linear-gradient(135deg,#2E9E6A,#5fd39a)",
        "grad-mute": "linear-gradient(135deg,#3B2E4A,#6B5E74)",
      },
      boxShadow: {
        soft: "0 12px 40px rgba(14,10,20,.06)",
        card: "0 14px 34px rgba(14,10,20,.08)",
        glow: "0 6px 16px rgba(107,31,184,.32)",
        glowSoft: "0 0 0 1px rgba(199,25,122,.12)",
        rail: "0 6px 16px rgba(107,31,184,.4)",
      },
    },
  },
  plugins: [],
};

export default config;
