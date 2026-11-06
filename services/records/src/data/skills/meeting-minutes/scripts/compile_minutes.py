#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Compile meeting DSL into HTML, Markdown and editable native board payloads.
Uses only the standard library; optional source checks inventory factual anchors.
"""

import argparse
import html
import json
import pathlib
import re
import sys
from typing import Any, Dict, List, Set, Tuple

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from feishu_board_drawer import (
    compile_full_meeting_whiteboard,
    layout_card_to_board_nodes,
    load_and_repair_json,
    normalize_card_schema,
    strip_internal_keys,
    wrap_text_cjk,
)

# ---------------------------------------------------------------------------
# 1. Semantic 12-Color Palettes
# ---------------------------------------------------------------------------
COLOR_THEMES: Dict[str, Dict[str, str]] = {
    "blue": {
        "name": "深海蓝",
        "emoji": "🔵",
        "accent": "#4C8DFF",
        "title_bg": "rgba(76, 141, 255, 0.16)",
        "title_text": "#6BA3FF",
        "block_bg": "rgba(36, 58, 105, 0.42)",
        "block_border": "rgba(76, 141, 255, 0.22)",
        "block_text": "#E2ECFF",
        "light_title_bg": "#E8F1FF",
        "light_title_text": "#1D5BD8",
        "light_block_bg": "#F2F7FF",
        "light_block_border": "#C6DCFF",
        "light_block_text": "#1E293B",
    },
    "amber": {
        "name": "琥珀橙",
        "emoji": "🟠",
        "accent": "#F59E0B",
        "title_bg": "rgba(245, 158, 11, 0.16)",
        "title_text": "#FBBF24",
        "block_bg": "rgba(92, 58, 24, 0.44)",
        "block_border": "rgba(245, 158, 11, 0.24)",
        "block_text": "#FEF3C7",
        "light_title_bg": "#FEF3C7",
        "light_title_text": "#B45309",
        "light_block_bg": "#FFFBEB",
        "light_block_border": "#FDE68A",
        "light_block_text": "#292524",
    },
    "green": {
        "name": "森系绿",
        "emoji": "🟢",
        "accent": "#22C55E",
        "title_bg": "rgba(34, 197, 94, 0.16)",
        "title_text": "#4ADE80",
        "block_bg": "rgba(22, 74, 45, 0.44)",
        "block_border": "rgba(34, 197, 94, 0.24)",
        "block_text": "#DCFCE7",
        "light_title_bg": "#DCFCE7",
        "light_title_text": "#15803D",
        "light_block_bg": "#F0FDF4",
        "light_block_border": "#BBF7D0",
        "light_block_text": "#14532D",
    },
    "rose": {
        "name": "珊瑚粉",
        "emoji": "🌸",
        "accent": "#F43F5E",
        "title_bg": "rgba(244, 63, 94, 0.16)",
        "title_text": "#FB7185",
        "block_bg": "rgba(95, 33, 55, 0.44)",
        "block_border": "rgba(244, 63, 94, 0.24)",
        "block_text": "#FFE4E6",
        "light_title_bg": "#FFE4E6",
        "light_title_text": "#BE123C",
        "light_block_bg": "#FFF1F2",
        "light_block_border": "#FECDD3",
        "light_block_text": "#3F1D28",
    },
    "cyan": {
        "name": "极光青",
        "emoji": "🩵",
        "accent": "#06B6D4",
        "title_bg": "rgba(6, 182, 212, 0.16)",
        "title_text": "#22D3EE",
        "block_bg": "rgba(19, 68, 82, 0.45)",
        "block_border": "rgba(6, 182, 212, 0.24)",
        "block_text": "#CFFAFE",
        "light_title_bg": "#CFFAFE",
        "light_title_text": "#0E7490",
        "light_block_bg": "#ECFEFF",
        "light_block_border": "#A5F3FC",
        "light_block_text": "#164E63",
    },
    "indigo": {
        "name": "靛青蓝",
        "emoji": "🔷",
        "accent": "#6366F1",
        "title_bg": "rgba(99, 102, 241, 0.16)",
        "title_text": "#818CF8",
        "block_bg": "rgba(43, 45, 102, 0.44)",
        "block_border": "rgba(99, 102, 241, 0.24)",
        "block_text": "#E0E7FF",
        "light_title_bg": "#E0E7FF",
        "light_title_text": "#4338CA",
        "light_block_bg": "#EEF2FF",
        "light_block_border": "#C7D2FE",
        "light_block_text": "#1E1B4B",
    },
    "purple": {
        "name": "星云紫",
        "emoji": "🟣",
        "accent": "#A855F7",
        "title_bg": "rgba(168, 85, 247, 0.16)",
        "title_text": "#C084FC",
        "block_bg": "rgba(68, 33, 99, 0.44)",
        "block_border": "rgba(168, 85, 247, 0.24)",
        "block_text": "#F3E8FF",
        "light_title_bg": "#F3E8FF",
        "light_title_text": "#7E22CE",
        "light_block_bg": "#FAF5FF",
        "light_block_border": "#E9D5FF",
        "light_block_text": "#3B0764",
    },
    "emerald": {
        "name": "翡翠绿",
        "emoji": "💚",
        "accent": "#10B981",
        "title_bg": "rgba(16, 185, 129, 0.16)",
        "title_text": "#34D399",
        "block_bg": "rgba(17, 70, 58, 0.45)",
        "block_border": "rgba(16, 185, 129, 0.24)",
        "block_text": "#D1FAE5",
        "light_title_bg": "#D1FAE5",
        "light_title_text": "#047857",
        "light_block_bg": "#ECFDF5",
        "light_block_border": "#A7F3D0",
        "light_block_text": "#064E3B",
    },
    "coral": {
        "name": "落日橘",
        "emoji": "🧡",
        "accent": "#F97316",
        "title_bg": "rgba(249, 115, 22, 0.16)",
        "title_text": "#FB923C",
        "block_bg": "rgba(94, 42, 24, 0.44)",
        "block_border": "rgba(249, 115, 22, 0.24)",
        "block_text": "#FFEDD5",
        "light_title_bg": "#FFEDD5",
        "light_title_text": "#C2410C",
        "light_block_bg": "#FFF7ED",
        "light_block_border": "#FED7AA",
        "light_block_text": "#431407",
    },
    "slate": {
        "name": "钛金灰",
        "emoji": "⚪",
        "accent": "#94A3B8",
        "title_bg": "rgba(148, 163, 184, 0.16)",
        "title_text": "#CBD5E1",
        "block_bg": "rgba(45, 55, 72, 0.48)",
        "block_border": "rgba(148, 163, 184, 0.24)",
        "block_text": "#F1F5F9",
        "light_title_bg": "#E2E8F0",
        "light_title_text": "#334155",
        "light_block_bg": "#F8FAFC",
        "light_block_border": "#CBD5E1",
        "light_block_text": "#1E293B",
    },
    "gold": {
        "name": "流光金",
        "emoji": "🟡",
        "accent": "#EAB308",
        "title_bg": "rgba(234, 179, 8, 0.16)",
        "title_text": "#FACC15",
        "block_bg": "rgba(85, 68, 18, 0.44)",
        "block_border": "rgba(234, 179, 8, 0.26)",
        "block_text": "#FEF9C3",
        "light_title_bg": "#FEF9C3",
        "light_title_text": "#A16207",
        "light_block_bg": "#FEFCE8",
        "light_block_border": "#FEF08A",
        "light_block_text": "#422006",
    },
    "crimson": {
        "name": "绯红预警",
        "emoji": "🔴",
        "accent": "#EF4444",
        "title_bg": "rgba(239, 68, 68, 0.18)",
        "title_text": "#F87171",
        "block_bg": "rgba(99, 27, 27, 0.48)",
        "block_border": "rgba(239, 68, 68, 0.28)",
        "block_text": "#FEE2E2",
        "light_title_bg": "#FEE2E2",
        "light_title_text": "#B91C1C",
        "light_block_bg": "#FEF2F2",
        "light_block_border": "#FECACA",
        "light_block_text": "#450A0A",
    },
}

# ---------------------------------------------------------------------------
# 2. Built-in 40+ Crisp Vector SVG Icons
# ---------------------------------------------------------------------------
SVG_PATHS: Dict[str, str] = {
    "compass": '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
    "target": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    "flag": '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    "crosshair": '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
    "crown": '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14"/>',
    "star": '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    "trophy": '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    "award": '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>',
    "layers": '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    "cpu": '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    "database": '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
    "server": '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    "terminal": '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    "git-merge": '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    "sliders": '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
    "wrench": '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    "hard-drive": '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
    "key": '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    "chart": '<line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>',
    "trending-up": '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    "pie-chart": '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    "bar-chart": '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
    "activity": '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    "dollar": '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    "gem": '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
    "arrow-up": '<line x1="12" x2="12" y1="19" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    "sprout": '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
    "alert": '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>',
    "flame": '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    "shield": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    "lock": '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "siren": '<path d="M7 18v-6a5 5 0 1 1 10 0v6"/><path d="M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z"/><path d="M21 12h1"/><path d="M18.5 4.5 18 5"/><path d="M2 12h1"/><path d="M12 2v1"/><path d="m4.929 4.929.707.707"/>',
    "octagon": '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "bug": '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
    "ban": '<circle cx="12" cy="12" r="10"/><line x1="4.93" x2="19.07" y1="4.93" y2="19.07"/>',
    "bell": '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    "check": '<polyline points="20 6 9 17 4 12"/>',
    "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    "globe": '<circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    "briefcase": '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    "scale": '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
    "megaphone": '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    "message": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    "gift": '<polyline points="20 12 20 22 4 22 4 12"/><rect width="20" height="5" x="2" y="7"/><line x1="12" x2="12" y1="22" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
    "share": '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
    "smile": '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
    "wand": '<path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M15 9h0"/><path d="M17.8 6.2 19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2 11 5"/>',
    "brain": '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>',
    "lightbulb": '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    "sparkles": '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M3 5h4"/>',
    "zap": '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    "rocket": '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    "heart-pulse": '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
    "file-text": '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/>',
    "calendar": '<rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
    "pin": '<line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
}


def get_svg(icon_key: str, size: int = 15) -> str:
    path = SVG_PATHS.get(icon_key, SVG_PATHS["layers"])
    return (
        f'<svg class="mm-icon" width="{size}" height="{size}" viewBox="0 0 24 24" '
        f'fill="none" stroke="currentColor" stroke-width="2" '
        f'stroke-linecap="round" stroke-linejoin="round">{path}</svg>'
    )


def esc(text: Any) -> str:
    if text is None:
        return ""
    s = html.escape(str(text))
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"@([\w\u4e00-\u9fa5\-]+)", r'<span class="mm-at">@\1</span>', s)
    return s


def format_callout_text(text: Any) -> str:
    """
    Taste-Skill Pillar 2 (Typography & Scannability):
    - Highlights lead-in verdict clause before the first comma/colon for 5-second executive scanning
    - Styles quoted concepts 「...」 and numeric/metric tokens with tabular-nums monospace
    """
    s = esc(text)
    if not s:
        return ""
    # Highlight quoted strategic terms 「...」
    s = re.sub(r"「([^」]+)」", r'<span class="mm-quote-term">「\1」</span>', s)
    # Highlight numeric metrics, percentages, deltas, latencies, versions, priorities
    s = re.sub(
        r"(?<![\w#])([+\-]?\d+(?:\.\d+)?(?:%|ms|s|万|亿|人月|FPS|QPS|px)?|\bP[0-3]\b|\bV\d+(?:\.\d+)+|\b\d{1,2}:\d{2}\b)",
        r'<span class="mm-num-token">\1</span>',
        s,
    )
    # Emphasize opening verdict clause up to first Chinese comma/colon if concise
    for sep in ("：", "，"):
        if sep in s:
            first_part, rest = s.split(sep, 1)
            plain_len = len(re.sub(r"<[^>]+>", "", first_part))
            if 4 <= plain_len <= 28:
                s = f'<strong class="mm-lead-clause">{first_part}{sep}</strong>{rest}'
            break
    return s


# ---------------------------------------------------------------------------
# 3. Code-Level Lossless Fidelity Verifier & Multi-Chunk Merger
# ---------------------------------------------------------------------------
ANCHOR_PATTERNS = {
    "metrics": re.compile(r"\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?(?:ms|s|万|亿|人月|FPS|QPS)\b", re.IGNORECASE),
    "owners": re.compile(r"@[\w\u4e00-\u9fa5\-]+"),
    "dates": re.compile(r"\b\d{1,2}-\d{1,2}\b|\b\d{1,2}:\d{2}\b|\bQ[1-4]\b"),
    "priorities": re.compile(r"\bP[0-3]\b|\bV\d+(?:\.\d+)+\b"),
}


def extract_fact_anchors(text: str) -> Dict[str, Set[str]]:
    return {k: set(pat.findall(text)) for k, pat in ANCHOR_PATTERNS.items()}


def verify_fidelity(dsl_data: Dict[str, Any], source_text: str = "") -> Dict[str, Any]:
    """
    Extract all hard fact anchors (metrics, @owners, dates, P0/versions) and verify
    100% retention between source transcript (if provided) and compiled DSL.
    """
    dsl_raw = json.dumps(dsl_data, ensure_ascii=False)
    dsl_anchors = extract_fact_anchors(dsl_raw)
    total_dsl_count = sum(len(v) for v in dsl_anchors.values())

    if not source_text:
        return {
            "mode": "internal_lock",
            "total_locked": total_dsl_count,
            "retention_pct": None,
            "missing": [],
            "breakdown": {k: sorted(list(v)) for k, v in dsl_anchors.items()},
        }

    src_anchors = extract_fact_anchors(source_text)
    missing: List[str] = []
    total_src = 0
    matched = 0
    for k, src_set in src_anchors.items():
        for item in src_set:
            total_src += 1
            if item in dsl_anchors.get(k, set()) or item in dsl_raw:
                matched += 1
            else:
                missing.append(f"[{k}] {item}")

    pct = round((matched / total_src) * 100.0, 1) if total_src > 0 else 100.0
    return {
        "mode": "source_crosscheck",
        "total_locked": total_dsl_count,
        "source_anchors": total_src,
        "matched_anchors": matched,
        "retention_pct": pct,
        "missing": missing,
        "breakdown": {k: sorted(list(v)) for k, v in dsl_anchors.items()},
    }


def merge_dsl_chunks(chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge multiple Map-Reduce JSON DSL chunks from a long 2-hour+ meeting into one unified DSL."""
    if not chunks:
        return {}
    base = dict(chunks[0])
    merged_sections = list(base.get("sections") or base.get("sec", []))
    merged_tabs = list(base.get("tabs", ["全部"]))
    summaries = [base.get("summary") or base.get("sum", "")]

    for ch in chunks[1:]:
        for tb in ch.get("tabs", []):
            if tb not in merged_tabs:
                merged_tabs.append(tb)
        s_txt = ch.get("summary") or ch.get("sum", "")
        if s_txt and s_txt not in summaries:
            summaries.append(s_txt)
        merged_sections.extend(ch.get("sections") or ch.get("sec", []))

    base["tabs"] = merged_tabs
    base["sections"] = merged_sections
    base["summary"] = " ".join(s for s in summaries if s)
    return base


# ---------------------------------------------------------------------------
# 4. Zero-Truncation CJK Dynamic SVG Whiteboard Renderer
# ---------------------------------------------------------------------------



def render_board_nodes_to_svg(nodes, canvas_w, canvas_h, interactive_id='', uid='wb0'):
    """Preview exactly the native payload colors and measured text geometry."""
    w, h = max(320, canvas_w+28), max(90, canvas_h+20)
    safe_uid = re.sub(r'[^a-zA-Z0-9_-]', '_', uid or interactive_id or 'wb0')
    shapes, connections = [], []
    for node in nodes:
        if node.get('type') == 'connector':
            a, b = node['start_object']['position'], node['end_object']['position']
            x1, y1, x2, y2 = a['x'], a['y'], b['x'], b['y']
            color = html.escape(node.get('style', {}).get('border_color', '#52656C'), quote=True)
            if abs(y2-y1) < 1 or abs(x2-x1) < 1:
                path = f'M {x1} {y1} L {x2} {y2}'
            elif x2 > x1:
                mx = (x1+x2)/2
                path = f'M {x1} {y1} H {mx} V {y2} H {x2}'
            else:
                my = (y1+y2)/2
                path = f'M {x1} {y1} V {my} H {x2} V {y2}'
            connections.append(f'<path d="{path}" fill="none" stroke="{color}" stroke-width="1.5" marker-end="url(#arrow-{safe_uid})"/>')
            continue
        if node.get('type') != 'composite_shape': continue
        x, y, nw, nh = (float(node.get(k, 0)) for k in ('x', 'y', 'width', 'height'))
        style, text = node.get('style', {}), node.get('text', {})
        fill = html.escape(style.get('fill_color', '#FCFDFD'), quote=True)
        border = html.escape(style.get('border_color', fill), quote=True)
        radius = 8 if node.get('composite_shape', {}).get('type') == 'round_rect' else 0
        shapes.append(f'<rect x="{x}" y="{y}" width="{nw}" height="{nh}" rx="{radius}" fill="{fill}" stroke="{border}" stroke-width="{style.get("border_width", 0)}"/>')
        content = text.get('content', '')
        if not content: continue
        lines = text.get('_wrapped_lines') or content.split('\n')
        size, align = text.get('font_size', 16), text.get('horizontal_align', 'left')
        tx = x+16 if align == 'left' else x+nw-16 if align == 'right' else x+nw/2
        anchor = {'left':'start', 'right':'end', 'center':'middle'}.get(align, 'start')
        lh = size*1.42
        top = y+(nh-len(lines)*lh)/2+size*1.02
        spans = ''.join(f'<tspan x="{tx}" y="{top+i*lh}">{html.escape(str(line))}</tspan>' for i,line in enumerate(lines))
        ink = html.escape(text.get('text_color', '#202E34'), quote=True)
        weight = 650 if text.get('text_weight') == 'bold' else 400
        shapes.append(f'<text fill="{ink}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" font-family="system-ui, PingFang SC, Microsoft YaHei, sans-serif" style="font-variant-numeric:tabular-nums">{spans}</text>')
    id_attr = f' id="{html.escape(interactive_id, quote=True)}"' if interactive_id else ''
    return (f'<div class="wb-canvas-wrap" onmousedown="startPan(event, this)" onwheel="wheelZoom(event, this)">'
        '<div class="wb-floating-controls">'
        '<button type="button" onclick="stepZoom(this, 1.15)" aria-label="放大画板">+</button>'
        '<button type="button" onclick="stepZoom(this, 0.87)" aria-label="缩小画板">−</button>'
        '<button type="button" onclick="resetZoom(this)" aria-label="重置画板">1:1</button>'
        '<button type="button" onclick="exportBoardPng(this)">PNG</button>'
        '<button type="button" onclick="exportBoardSvg(this)">SVG</button></div>'
        '<div class="wb-pan-stage" data-scale="1" data-tx="0" data-ty="0">'
        f'<svg{id_attr} xmlns="http://www.w3.org/2000/svg" class="wb-svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
        f'<defs><marker id="arrow-{safe_uid}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#52656C"/></marker></defs>'
        '<rect width="100%" height="100%" fill="#F2F4F5"/>'
        f'<g class="wb-viewport">{"".join(shapes)}{"".join(connections)}</g></svg></div></div>')



def style_table_cell(text: Any) -> str:
    raw = str(text or "").strip()
    escaped = esc(raw)
    if raw in ("P0", "高", "高风险", "紧急"):
        return f'<span class="mm-badge mm-badge-danger">{escaped}</span>'
    if raw in ("P1", "中", "中风险"):
        return f'<span class="mm-badge mm-badge-warn">{escaped}</span>'
    if raw in ("P2", "P3", "低", "低风险"):
        return f'<span class="mm-badge mm-badge-info">{escaped}</span>'
    if raw.startswith("🟢") or raw in ("正常", "已完成", "通过", "达标"):
        label = raw.replace("🟢", "").strip()
        return f'<span class="mm-status-lamp"><span class="lamp-dot lamp-green"></span>{esc(label or "正常")}</span>'
    if raw.startswith("🔴") or raw in ("阻塞", "异常", "延期", "未通过"):
        label = raw.replace("🔴", "").strip()
        return f'<span class="mm-status-lamp"><span class="lamp-dot lamp-red"></span>{esc(label or "阻塞")}</span>'
    if raw.startswith("🟡") or raw in ("关注", "进行中", "风险"):
        label = raw.replace("🟡", "").strip()
        return f'<span class="mm-status-lamp"><span class="lamp-dot lamp-amber"></span>{esc(label or "关注")}</span>'
    if raw.startswith("🔵"):
        label = raw.replace("🔵", "").strip()
        return f'<span class="mm-status-lamp"><span class="lamp-dot lamp-blue"></span>{esc(label or "规划中")}</span>'
    return escaped


# ---------------------------------------------------------------------------
# 5. Card Dual-Renderers (Zero-Truncation Board Vector + Rich DOM)
# ---------------------------------------------------------------------------
BOARD_DEFAULT_CARD_TYPES = {"flow", "branch", "kpi", "timeline", "grid", "pros-cons"}


def wrap_card_shell(
    title: str,
    dom_html: str,
    card_obj: Dict[str, Any],
    card_id: str,
) -> str:
    ctype = card_obj.get("type", "table")
    card_no_title = dict(card_obj)
    card_no_title["title"] = ""
    b_nodes, bw, bh, m_code = layout_card_to_board_nodes(card_no_title, origin_x=14.0, origin_y=10.0, id_prefix=card_id)
    board_svg_html = render_board_nodes_to_svg(b_nodes, bw, bh, uid=card_id)

    default_board = True
    mode_class = "card-mode-board" if default_board else "card-mode-dom"
    clean_nodes = strip_internal_keys(b_nodes)
    payload_json = html.escape(json.dumps({"nodes": clean_nodes}, ensure_ascii=False))
    mermaid_esc = html.escape(m_code).replace("\n", "&#10;")

    header_html = (
        f'<div class="mm-card-header">'
        f'<div class="mm-card-title-group">'
        f'<span class="wb-badge">飞书画板</span>'
        f'<span class="mm-card-title">{esc(title or ctype)}</span>'
        f'</div>'
        f'<div class="mm-card-actions">'
        f'<div class="mm-seg-group" role="group" aria-label="视图模式切换">'
        f'<button type="button" class="mm-seg-btn seg-board" onclick="setCardMode(this, \'board\')" title="飞书画板 2D 矢量节点视图"> 画板直绘</button>'
        f'<button type="button" class="mm-seg-btn seg-dom" onclick="setCardMode(this, \'dom\')" title="原生结构化表格/组件视图"> 原生组件</button>'
        f'</div>'
        f'<button type="button" class="mm-card-btn" onclick="showBoardCode(this)" '
        f'data-nodes="{payload_json}" data-mermaid="{mermaid_esc}" title="获取该卡片的飞书画板 API 节点与 Mermaid 语法">'
        f' API/语法</button>'
        f'<button type="button" class="mm-card-expand" onclick="zoomCard(this)" title="全屏展开画板">'
        f'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        f'<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>'
        f'<line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
        f'</button></div></div>'
    )
    return (
        f'<div class="mm-card mm-card-{ctype} {mode_class}" id="card-{card_id}" data-title="{esc(title or ctype)}">'
        f'{header_html}'
        f'<div class="mm-card-body">'
        f'<div class="view-board-canvas">{board_svg_html}</div>'
        f'<div class="view-dom-content">{dom_html}</div>'
        f'</div></div>'
    )


def render_flow_card(card: Dict[str, Any], cid: str) -> str:
    steps = card.get("steps", [])
    nodes = []
    for idx, st in enumerate(steps):
        t = st.get("t") or st.get("title", "")
        d = st.get("d") or st.get("desc", "")
        s = st.get("s") or st.get("status", "pending")
        meta = st.get("meta", "")
        meta_html = f'<div class="flow-meta">{esc(meta)}</div>' if meta else ""
        desc_html = f'<div class="flow-desc">{esc(d)}</div>' if d else ""
        nodes.append(
            f'<div class="flow-step flow-step-{esc(s)}">'
            f'{meta_html}<div class="flow-title">{esc(t)}</div>{desc_html}'
            f'</div>'
        )
        if idx < len(steps) - 1:
            nodes.append('<div class="flow-arrow">→</div>')
    prog = card.get("progress")
    prog_html = f'<div class="flow-progress-track"><div class="flow-progress-bar" style="width:{int(prog)}%"></div></div>' if prog is not None else ""
    body = f'<div class="flow-track">{"".join(nodes)}</div>{prog_html}'
    return wrap_card_shell(card.get("title", "阶段推进链路"), body, card, cid)


def render_branch_card(card: Dict[str, Any], cid: str) -> str:
    root = card.get("root", "输入源")
    hub = card.get("hub", "核心分发枢纽")
    branches = card.get("branches", [])
    branch_rows = []
    for br in branches:
        chain = []
        for idx, node in enumerate(br):
            nt = node.get("t", "") if isinstance(node, dict) else str(node)
            ns = node.get("s", "pending") if isinstance(node, dict) else "pending"
            chain.append(f'<div class="branch-node flow-step-{esc(ns)}">{esc(nt)}</div>')
            if idx < len(br) - 1:
                chain.append('<span class="flow-arrow">→</span>')
        branch_rows.append(f'<div class="branch-row"><span class="branch-fork-arrow">↳</span>{"".join(chain)}</div>')
    body = (
        f'<div class="branch-container">'
        f'<div class="branch-root">{esc(root)}</div>'
        f'<span class="flow-arrow">→</span>'
        f'<div class="branch-hub">{esc(hub)}</div>'
        f'<div class="branch-lanes">{"".join(branch_rows)}</div>'
        f'</div>'
    )
    return wrap_card_shell(card.get("title", "架构与分支链路"), body, card, cid)


def render_kpi_card(card: Dict[str, Any], cid: str) -> str:
    metrics = card.get("metrics", [])
    items_html = []
    for m in metrics:
        label = m.get("label", "")
        from_val = m.get("from")
        to_val = m.get("to") or m.get("value", "")
        from_lbl = m.get("fromLabel", "优化前")
        to_lbl = m.get("toLabel", "当前/目标")
        delta = m.get("delta", "")
        trend = m.get("trend", "up")
        delta_html = f'<span class="kpi-delta kpi-trend-{esc(trend)}">{esc(delta)}</span>' if delta else ""
        if from_val:
            items_html.append(
                f'<div class="kpi-box">'
                f'<div class="kpi-box-title">{esc(label)} {delta_html}</div>'
                f'<div class="kpi-compare">'
                f'<div class="kpi-col"><span class="kpi-sub">{esc(from_lbl)}</span><span class="kpi-num kpi-num-muted">{esc(from_val)}</span></div>'
                f'<div class="kpi-arrow">→</div>'
                f'<div class="kpi-col"><span class="kpi-sub">{esc(to_lbl)}</span><span class="kpi-num kpi-num-highlight">{esc(to_val)}</span></div>'
                f'</div></div>'
            )
        else:
            items_html.append(
                f'<div class="kpi-box">'
                f'<div class="kpi-box-title">{esc(label)}</div>'
                f'<div class="kpi-single"><span class="kpi-num kpi-num-highlight">{esc(to_val)}</span>{delta_html}</div>'
                f'</div>'
            )
    return wrap_card_shell(card.get("title", "核心指标看板"), f'<div class="kpi-grid">{"".join(items_html)}</div>', card, cid)


def render_grid_card(card: Dict[str, Any], cid: str) -> str:
    cols = int(card.get("cols", 3))
    items = card.get("items", [])
    cells = []
    for it in items:
        t = it.get("t") or it.get("title", "")
        d = it.get("d") or it.get("desc", "")
        c = it.get("c") or it.get("color", "blue")
        accent = COLOR_THEMES.get(c, COLOR_THEMES["blue"])["accent"]
        cells.append(
            f'<div class="grid-col-item">'
            f'<div class="grid-col-title"><span class="grid-dot" style="background:{accent}"></span>{esc(t)}</div>'
            f'<div class="grid-col-desc">{esc(d)}</div>'
            f'</div>'
        )
    return wrap_card_shell(card.get("title", "核心要点矩阵"), f'<div class="mm-pillar-grid" style="--grid-cols:{cols}">{"".join(cells)}</div>', card, cid)


def render_table_card(card: Dict[str, Any], cid: str, merge_first_col: bool = False) -> str:
    headers = card.get("headers", [])
    rows = card.get("rows", [])
    th_html = "".join(f"<th>{esc(h)}</th>" for h in headers)
    rowspans = [1] * len(rows)
    if merge_first_col and rows:
        i = 0
        while i < len(rows):
            j = i + 1
            while j < len(rows) and rows[j] and rows[i] and rows[j][0] == rows[i][0]:
                rowspans[i] += 1
                rowspans[j] = 0
                j += 1
            i = j

    tr_list = []
    for r_idx, row in enumerate(rows):
        tds = []
        for c_idx, cell in enumerate(row):
            if c_idx == 0 and merge_first_col:
                if rowspans[r_idx] == 0:
                    continue
                rs_attr = f' rowspan="{rowspans[r_idx]}" class="td-merged-group"' if rowspans[r_idx] > 1 else ' class="td-merged-group"'
                tds.append(f"<td{rs_attr}>{style_table_cell(cell)}</td>")
            else:
                tds.append(f"<td>{style_table_cell(cell)}</td>")
        tr_list.append(f"<tr>{''.join(tds)}</tr>")

    table_html = f'<div class="mm-table-wrap"><table class="mm-table"><thead><tr>{th_html}</tr></thead><tbody>{"".join(tr_list)}</tbody></table></div>'
    return wrap_card_shell(card.get("title", "结构化数据表"), table_html, card, cid)


def render_timeline_card(card: Dict[str, Any], cid: str) -> str:
    mode = card.get("mode", "horizontal")
    events = card.get("events", [])
    nodes = []
    for ev in events:
        tm = ev.get("time", "")
        t = ev.get("t") or ev.get("title", "")
        owner = ev.get("owner", "")
        s = ev.get("s") or ev.get("status", "todo")
        d = ev.get("d") or ev.get("desc", "")
        owner_html = esc(owner if str(owner).startswith("@") else f"@{owner}") if owner else ""
        desc_html = f'<div class="tl-desc">{esc(d)}</div>' if d else ""
        nodes.append(
            f'<div class="tl-item tl-status-{esc(s)}">'
            f'<div class="tl-marker"><span class="tl-dot"></span><span class="tl-time">{esc(tm)}</span></div>'
            f'<div class="tl-content">'
            f'<div class="tl-title">{esc(t)} {owner_html}</div>'
            f'{desc_html}'
            f'</div></div>'
        )
    return wrap_card_shell(card.get("title", "里程碑与推进时间轴"), f'<div class="tl-container tl-mode-{esc(mode)}">{"".join(nodes)}</div>', card, cid)


def render_pros_cons_card(card: Dict[str, Any], cid: str) -> str:
    left = card.get("left", {})
    right = card.get("right", {})
    verdict = card.get("verdict", "")

    def render_side(side: Dict[str, Any], default_color: str) -> str:
        c = side.get("c", default_color)
        accent = COLOR_THEMES.get(c, COLOR_THEMES["blue"])["accent"]
        tag = side.get("tag", "")
        tag_html = f'<span class="pc-tag" style="border-color:{accent};color:{accent}">{esc(tag)}</span>' if tag else ""
        li_html = "".join(f"<li>{esc(x)}</li>" for x in side.get("items", []))
        return (
            f'<div class="pc-box" style="border-top:2px solid {accent}">'
            f'<div class="pc-header"><span>{esc(side.get("t", ""))}</span>{tag_html}</div>'
            f'<ul class="pc-list">{li_html}</ul>'
            f'</div>'
        )

    verdict_html = f'<div class="pc-verdict">{get_svg("check-circle", 14)} <span>{esc(verdict)}</span></div>' if verdict else ""
    body = f'<div class="pc-grid">{render_side(left, "green")}{render_side(right, "amber")}</div>{verdict_html}'
    return wrap_card_shell(card.get("title", "方案比选与博弈决策"), body, card, cid)


def render_action_list_card(card: Dict[str, Any], cid: str) -> str:
    actions = card.get("actions", [])
    total_cnt = len(actions)
    done_cnt = sum(1 for a in actions if (a.get("s") or a.get("status", "todo")) == "done")
    pct = round((done_cnt / total_cnt) * 100) if total_cnt > 0 else 0
    rows = []
    for act in actions:
        t = act.get("t") or act.get("task", "")
        owner = act.get("owner", "")
        p = act.get("p") or act.get("priority", "P1")
        due = act.get("due", "")
        s = act.get("s") or act.get("status", "todo")
        checked = "checked" if s == "done" else ""
        due_html = f'<span class="act-due">📅 {esc(due)}</span>' if due else ""
        owner_html = esc(owner if str(owner).startswith("@") else f"@{owner}") if owner else ""
        rows.append(
            f'<div class="act-row act-{esc(s)}">'
            f'<input type="checkbox" class="act-check" {checked} onchange="updateActionProgress(this)">'
            f'{style_table_cell(p)}'
            f'<span class="act-text">{esc(t)}</span>'
            f'<div class="act-meta">{owner_html}{due_html}</div>'
            f'</div>'
        )
    prog_bar = (
        f'<div class="act-prog-header">'
        f'<span class="act-prog-label">执行进度：<strong class="act-prog-num">{done_cnt}/{total_cnt} ({pct}%)</strong></span>'
        f'<div class="act-prog-track"><div class="act-prog-fill" style="width:{pct}%"></div></div>'
        f'</div>'
    )
    return wrap_card_shell(card.get("title", "会后行动项 (Action Items)"), f'{prog_bar}<div class="act-list">{"".join(rows)}</div>', card, cid)


def render_quote_decision_card(card: Dict[str, Any], cid: str) -> str:
    speaker = card.get("speaker", "核心决议")
    role = card.get("role", "")
    text = card.get("text", "")
    impact = card.get("impact", "")
    role_html = f'<span class="qd-role">{esc(role)}</span>' if role else ""
    impact_html = f'<div class="qd-impact">{esc(impact)}</div>' if impact else ""
    body = (
        f'<div class="qd-box">'
        f'<div class="qd-top">{get_svg("award", 15)} <strong>{esc(speaker)}</strong> {role_html}</div>'
        f'<div class="qd-text">“{esc(text)}”</div>'
        f'{impact_html}'
        f'</div>'
    )
    return wrap_card_shell(card.get("title", "高管定调与红线决议"), body, card, cid)


def render_risk_matrix_card(card: Dict[str, Any], cid: str) -> str:
    risks = card.get("risks", [])
    headers = ["风险等级", "风险事项描述", "应对与缓解预案 (Mitigation)", "责任人"]
    rows = []
    level_map = {"high": "高风险", "med": "中风险", "low": "低风险"}
    for r in risks:
        lvl = level_map.get(str(r.get("level", "med")).lower(), r.get("level", "中风险"))
        rows.append([lvl, r.get("risk", ""), r.get("mitigation", ""), r.get("owner", "")])
    return render_table_card({"type": "risk-matrix", "title": card.get("title", "风险识别与缓解矩阵"), "headers": headers, "rows": rows, "risks": risks}, cid)


def render_funnel_metric_card(card: Dict[str, Any], cid: str) -> str:
    bars = card.get("bars", [])
    rows = []
    for b in bars:
        lbl = b.get("label", "")
        val = b.get("val", "")
        pct = max(2, min(100, int(b.get("pct", 50))))
        c = b.get("c", "blue")
        accent = COLOR_THEMES.get(c, COLOR_THEMES["blue"])["accent"]
        note = b.get("note", "")
        note_html = f'<span class="fn-note">{esc(note)}</span>' if note else ""
        rows.append(
            f'<div class="fn-row">'
            f'<div class="fn-top"><span class="fn-label">{esc(lbl)} {note_html}</span><span class="fn-val">{esc(val)}</span></div>'
            f'<div class="fn-track"><div class="fn-bar" style="width:{pct}%;background:{accent}"></div></div>'
            f'</div>'
        )
    return wrap_card_shell(card.get("title", "转化漏斗与分布占比"), f'<div class="fn-list">{"".join(rows)}</div>', card, cid)


def render_card(raw_card: Dict[str, Any], cid: str) -> str:
    card = normalize_card_schema(raw_card)
    ctype = card.get("type", "table")
    if ctype == "flow":
        return render_flow_card(card, cid)
    if ctype == "branch":
        return render_branch_card(card, cid)
    if ctype == "kpi":
        return render_kpi_card(card, cid)
    if ctype == "grid":
        return render_grid_card(card, cid)
    if ctype == "status-table":
        return render_table_card(card, cid, merge_first_col=True)
    if ctype == "timeline":
        return render_timeline_card(card, cid)
    if ctype == "pros-cons":
        return render_pros_cons_card(card, cid)
    if ctype == "action-list":
        return render_action_list_card(card, cid)
    if ctype == "quote-decision":
        return render_quote_decision_card(card, cid)
    if ctype == "risk-matrix":
        return render_risk_matrix_card(card, cid)
    if ctype == "funnel-metric":
        return render_funnel_metric_card(card, cid)
    return render_table_card(card, cid, merge_first_col=False)


# ---------------------------------------------------------------------------
# 6. Full HTML Document Assembly
# ---------------------------------------------------------------------------
def generate_theme_css():
    # Topic labels are quiet; semantic colors belong to data and status.
    return '\n'.join(
        f'.sec-theme-{key} {{' + '--sec-accent:#5178C6;--sec-title-bg:#E8EDEE;--sec-title-text:#1F2329;'
        '--sec-block-bg:var(--bg-card-header);--sec-block-border:transparent;--sec-block-text:var(--text-main);}'
        for key in COLOR_THEMES
    )



def compile_html(
    data: Dict[str, Any],
    full_board_data: Dict[str, Any],
    fidelity_report: Dict[str, Any],
) -> str:
    title = data.get("title") or data.get("t", "智能会议纪要")
    subtitle = data.get("subtitle") or data.get("sub", "")
    summary = data.get("summary") or data.get("sum", "")
    theme = data.get("theme", "feishu-light")
    sections = data.get("sections") or data.get("sec", [])

    # Parse subtitle into sleek glassmorphic metadata chips
    meta_chips_list: List[str] = []
    if subtitle:
        parts = [p.strip() for p in subtitle.split("|") if p.strip()]
        chip_icons = ["calendar", "users", "sparkles", "clock"]
        for i, pt in enumerate(parts):
            ic = chip_icons[i % len(chip_icons)]
            meta_chips_list.append(f'<span class="mm-meta-chip">{get_svg(ic, 13)} <span>{esc(pt)}</span></span>')
    meta_chips_html = f'<div class="mm-meta-strip">{"".join(meta_chips_list)}</div>' if meta_chips_list else ""

    tabs = data.get("tabs", [])
    if not tabs:
        seen = ["全部"]
        for s in sections:
            tb = s.get("tab")
            if tb and tb not in seen:
                seen.append(tb)
        tabs = seen if len(seen) > 1 else ["全部"]

    tabs_html = "".join(
        f'<button class="mm-tab {"active" if i == 0 else ""}" onclick="filterTab(this, \'{esc(tb)}\')">{esc(tb)}</button>'
        for i, tb in enumerate(tabs)
    )

    fid_pct = fidelity_report.get("retention_pct")
    fid_status = f"{fid_pct}%" if fid_pct is not None else "未对照原文"
    fid_cnt = fidelity_report.get("total_locked", 0)
    fid_Breakdown = html.escape(json.dumps(fidelity_report.get("breakdown", {}), ensure_ascii=False))

    summary_html = (
        f'<div class="mm-exec-summary">'
        f'<div class="mm-exec-bar"></div>'
        f'<div class="mm-exec-content">'
        f'<div class="mm-exec-label">{get_svg("sparkles", 14)} <span>核心决议摘要</span></div>'
        f'<div class="mm-exec-text">{format_callout_text(summary)}</div>'
        f'</div>'
        f'<button class="fid-badge" onclick="showFidelityAudit(this)" data-audit="{fid_Breakdown}" title="点击查看无损锁定的数字、人名、日期锚点明细">'
        f'<span class="fid-pulse"></span>锚点清单：{fid_cnt} 项 · {fid_status}</button>'
        f'</div>'
        if summary
        else ""
    )

    sections_html_list: List[str] = []
    toc_items_list: List[str] = []
    total_callouts = 0
    total_cards = 0

    for idx, sec in enumerate(sections):
        stitle = sec.get("title") or sec.get("t", f"议题 {idx + 1}")
        scolor = sec.get("color") or sec.get("c", "blue")
        if scolor not in COLOR_THEMES:
            scolor = "blue"
        sicon = sec.get("icon") or sec.get("ic", "layers")
        stab = sec.get("tab", "全部")
        stag = sec.get("tag", "")
        collapsed = "collapsed" if sec.get("collapsed") else ""
        items = sec.get("items") or sec.get("b", [])

        sec_id = f"sec-{idx}"
        sec_num = f"{idx + 1:02d}"
        card_count = sum(1 for it in items if isinstance(it, dict) and "type" in it)
        callout_count = len(items) - card_count
        total_cards += card_count
        total_callouts += callout_count

        accent_hex = COLOR_THEMES[scolor]["accent"]
        toc_items_list.append(
            f'<a href="#{sec_id}" class="toc-item {"active" if idx == 0 else ""}" data-target="{sec_id}" onclick="scrollToSection(event, \'{sec_id}\')">'
            f'<span class="toc-dot" style="background:{accent_hex}"></span>'
            f'<span class="toc-idx">{sec_num}</span>'
            f'<span class="toc-text">{esc(stitle)}</span>'
            f'<span class="toc-cnt">{len(items)}</span>'
            f'</a>'
        )

        meta_pill = f'<span class="sec-meta-count">{callout_count} 结论 · {card_count} 画板</span>'
        tag_html = f'<span class="sec-right-tag">{esc(stag)}</span>' if stag else ""

        body_blocks = []
        for i_idx, item in enumerate(items):
            if isinstance(item, str):
                raw_plain = html.escape(item)
                body_blocks.append(
                    f'<div class="mm-callout-row">'
                    f'<span class="mm-rail-node"></span>'
                    f'<div class="mm-callout-block">'
                    f'<div class="mm-callout-inner">{format_callout_text(item)}</div>'
                    f'<button type="button" class="mm-copy-mini" data-copy="{raw_plain}" onclick="copyCalloutText(this)" title="复制本条结论"></button>'
                    f'</div></div>'
                )
            elif isinstance(item, dict) and "type" not in item:
                txt = item.get("text") or item.get("t", "")
                itag = item.get("tag", "")
                iicon = item.get("icon", "")
                icon_prefix = f'{get_svg(iicon, 14)} ' if iicon else ""
                tag_suffix = f' <span class="callout-inline-tag">{esc(itag)}</span>' if itag else ""
                raw_plain = html.escape(txt)
                body_blocks.append(
                    f'<div class="mm-callout-row">'
                    f'<span class="mm-rail-node"></span>'
                    f'<div class="mm-callout-block">'
                    f'<div class="mm-callout-inner">{icon_prefix}{format_callout_text(txt)}{tag_suffix}</div>'
                    f'<button type="button" class="mm-copy-mini" data-copy="{raw_plain}" onclick="copyCalloutText(this)" title="复制本条结论"></button>'
                    f'</div></div>'
                )
            elif isinstance(item, dict):
                body_blocks.append(render_card(item, f"s{idx}_c{i_idx}"))

        sections_html_list.append(
            f'<section id="{sec_id}" class="mm-section sec-theme-{scolor} {collapsed}" data-tab="{esc(stab)}">'
            f'<div class="mm-sec-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">'
            f'<span class="mm-sec-caret">▾</span>'
            f'<span class="mm-sec-idx">{sec_num}</span>'
            f'<div class="mm-sec-pill">{get_svg(sicon, 14)} <span>{esc(stitle)}</span></div>'
            f'{meta_pill}'
            f'{tag_html}'
            f'</div>'
            f'<div class="mm-sec-body">{"".join(body_blocks)}</div>'
            f'</section>'
        )

    wb_meta = full_board_data["meta"]
    wb_nodes = full_board_data["full_whiteboard_payload"]["nodes"]
    full_wb_svg = render_board_nodes_to_svg(
        wb_nodes,
        wb_meta["canvas_width"],
        wb_meta["canvas_height"],
        interactive_id="panoramic-wb-svg",
        uid="pano_all",
    )
    full_wb_json_escaped = html.escape(json.dumps(full_board_data["feishu_openapi_clean_payload"], ensure_ascii=False))
    theme_css = generate_theme_css()

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(title)}</title>
<style>
/* Taste-Skill v3.0 Modern Aesthetic Architecture (DESIGN_VARIANCE: 7 | MOTION_INTENSITY: 6 | VISUAL_DENSITY: 7) */
:root {{
  --bg-page: #0B0D12;
  --bg-ambient-1: rgba(76, 141, 255, 0.13);
  --bg-ambient-2: rgba(6, 182, 212, 0.09);
  --bg-surface: rgba(20, 23, 31, 0.82);
  --bg-sec-card: rgba(25, 28, 38, 0.72);
  --bg-card: #1A1D26;
  --bg-card-header: rgba(36, 40, 52, 0.65);
  --bg-step: #212531;
  --wb-canvas-bg: #12151E;
  --border-subtle: rgba(255, 255, 255, 0.075);
  --border-card: rgba(255, 255, 255, 0.105);
  --specular-top: inset 0 1px 0 rgba(255, 255, 255, 0.065);
  --text-main: #F8FAFC;
  --text-muted: #94A3B8;
  --text-dim: #64748B;
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "HarmonyOS Sans SC", "PingFang SC", "MiSans", "Microsoft YaHei", sans-serif;

}}
body[data-theme="feishu-light"] {{
  --bg-page: #EEF2F7;
  --bg-ambient-1: rgba(59, 130, 246, 0.10);
  --bg-ambient-2: rgba(16, 185, 129, 0.07);
  --bg-surface: rgba(255, 255, 255, 0.92);
  --bg-sec-card: #FFFFFF;
  --bg-card: #FFFFFF;
  --bg-card-header: #F8FAFC;
  --bg-step: #F8FAFC;
  --wb-canvas-bg: #F8FAFC;
  --border-subtle: rgba(15, 23, 42, 0.075);
  --border-card: rgba(15, 23, 42, 0.11);
  --specular-top: inset 0 1px 0 rgba(255, 255, 255, 0.9);
  --text-main: #0F172A;
  --text-muted: #475569;
  --text-dim: #64748B;
}}
body[data-theme="ocean-glass"] {{
  --bg-page: #060B16;
  --bg-ambient-1: rgba(6, 182, 212, 0.16);
  --bg-ambient-2: rgba(99, 102, 241, 0.14);
  --bg-surface: rgba(13, 21, 38, 0.78);
  --bg-sec-card: rgba(18, 28, 48, 0.72);
  --bg-card: rgba(24, 36, 62, 0.82);
  --bg-card-header: rgba(34, 50, 82, 0.65);
  --bg-step: rgba(28, 42, 70, 0.9);
  --wb-canvas-bg: #0A1224;
  --border-subtle: rgba(148, 163, 184, 0.12);
  --border-card: rgba(56, 189, 248, 0.20);
  --text-main: #F8FAFC;
  --text-muted: #94A3B8;
}}
body[data-theme="minimal-ink"] {{
  --bg-page: #F6F5F0;
  --bg-ambient-1: rgba(24, 24, 27, 0.03);
  --bg-ambient-2: rgba(24, 24, 27, 0.02);
  --bg-surface: #FFFFFF;
  --bg-sec-card: #FFFFFF;
  --bg-card: #FAFAFA;
  --bg-card-header: #F4F4F5;
  --bg-step: #FFFFFF;
  --wb-canvas-bg: #F2F4F5;
  --border-subtle: #E4E4E7;
  --border-card: #D4D4D8;
  --text-main: #18181B;
  --text-muted: #52525B;
}}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ scroll-behavior: smooth; }}
body {{
  background-color: var(--bg-page);
  background:none;
  background-attachment: fixed;
  color: var(--text-main);
  font-family: var(--font-sans);
  font-size: 13.5px;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  padding: 24px 20px 72px;
  transition: background-color 0.25s ease, color 0.2s ease;
}}
/* Asymmetric 2-Column Executive Workspace */
.mm-workspace {{
  max-width: 1260px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 256px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}}
.mm-workspace.sidebar-collapsed {{
  grid-template-columns: minmax(0, 1020px);
  justify-content: center;
}}
.mm-workspace.sidebar-collapsed .mm-sidebar {{
  display: none;
}}
/* Left Sticky Glass Rail (Sidebar) */
.mm-sidebar {{
  position: sticky;
  top: 20px;
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--bg-surface);
  
  
  border: 1px solid var(--border-subtle);
  box-shadow:none;
  border-radius: 14px;
  padding: 16px;
  overflow: hidden;
}}
body[data-theme="feishu-light"] .mm-sidebar,
body[data-theme="minimal-ink"] .mm-sidebar {{
  box-shadow:none;
}}
.sb-brand {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}}
.sb-brand-badge {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #38BDF8;
}}
.sb-search-wrap {{
  position: relative;
}}
.sb-search-input {{
  width: 100%;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 8px;
  padding: 7px 10px 7px 28px;
  color: var(--text-main);
  font-size: 12px;
  font-family: var(--font-sans);
  outline: none;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}}
.sb-search-input:focus {{
  border-color: #4C8DFF;
  box-shadow:none;
}}
.sb-search-icon {{
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-dim);
  font-size: 12px;
  pointer-events: none;
}}
/* Bento 2x2 Telemetry Mini-Grid */
.sb-bento-stats {{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}}
.sb-stat-card {{
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  box-shadow:none;
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
}}
.sb-stat-num {{
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-main);
  line-height: 1.2;
}}
.sb-stat-lbl {{
  font-size: 10.5px;
  color: var(--text-dim);
  margin-top: 2px;
}}
.sb-toc-title {{
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-top: 2px;
}}
.sb-toc-list {{
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  padding-right: 2px;
}}
.toc-item {{
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: 7px;
  text-decoration: none;
  color: var(--text-muted);
  font-size: 12px;
  transition: background-color 0.15s ease;
  border: 1px solid transparent;
}}
.toc-item:hover {{
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-main);
}}
body[data-theme="feishu-light"] .toc-item:hover {{
  background: #F1F5F9;
}}
.toc-item.active {{
  background: rgba(76, 141, 255, 0.13);
  border-color: rgba(76, 141, 255, 0.28);
  color: var(--text-main);
  font-weight: 600;
}}
.toc-dot {{
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}}
.toc-idx {{
  font-family: var(--font-sans);
  font-size: 10.5px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}}
.toc-text {{
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}}
.toc-cnt {{
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.05);
  padding: 0 5px;
  border-radius: 99px;
}}
/* Main Document Container */
.mm-container {{
  background: var(--bg-surface);
  
  
  border: 1px solid var(--border-subtle);
  box-shadow:none;
  border-radius: 16px;
  padding: 28px 32px 44px;
  min-width: 0;
}}
body[data-theme="feishu-light"] .mm-container,
body[data-theme="minimal-ink"] .mm-container {{
  box-shadow:none;
}}
.mm-top-bar {{
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border-subtle);
}}
.mm-eyebrow {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #38BDF8;
}}
.mm-title-row {{
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  width: 100%;
}}
.mm-title {{
  font-size: clamp(21px, 2.2vw, 25px);
  font-weight: 750;
  letter-spacing: -0.024em;
  line-height: 1.26;
  color: var(--text-main);
  white-space: nowrap;
}}
.mm-meta-strip {{
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  margin-top: 2px;
}}
.mm-meta-chip {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  flex-shrink: 0;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  box-shadow:none;
  padding: 4px 10px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
}}
.mm-meta-chip svg {{ flex-shrink: 0; }}
.mm-toolbar {{ display: flex; align-items: center; gap: 7px; flex-shrink: 0; flex-wrap: wrap; }}
.mm-select, .mm-btn {{
  background: var(--bg-card);
  color: var(--text-muted);
  border: 1px solid var(--border-card);
  box-shadow:none;
  border-radius: 7px;
  padding: 5.5px 11px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.16s cubic-bezier(0.22, 1, 0.36, 1);
}}
.mm-select:hover, .mm-btn:hover, .mm-btn.active-mode {{
  color: #F8FAFC;
  border-color: #4C8DFF;
  background: rgba(76, 141, 255, 0.22);
  transform: translateY(-1px);
}}
body[data-theme="feishu-light"] .mm-btn:hover,
body[data-theme="feishu-light"] .mm-btn.active-mode {{
  color: #1D4ED8;
  background: #EFF6FF;
}}
/* Bento Executive Summary Banner */
.mm-exec-summary {{
  position: relative;
  margin-top: 16px;
  padding: 13px 16px 13px 18px;
  border-radius: 11px;
  background:none;
  border: 1px solid rgba(76, 141, 255, 0.24);
  box-shadow:none;
  color: var(--text-main);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  overflow: hidden;
}}
.mm-exec-bar {{
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background:none;
}}
.mm-exec-content {{ flex: 1; min-width: 240px; }}
.mm-exec-label {{
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #60A5FA;
  margin-bottom: 3px;
}}
body[data-theme="feishu-light"] .mm-exec-label {{ color: #1D4ED8; }}
.mm-exec-text {{ font-size: 13.2px; line-height: 1.58; }}
.fid-badge {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(34, 197, 94, 0.14);
  border: 1px solid rgba(34, 197, 94, 0.38);
  color: #4ADE80;
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 4.5px 11px;
  border-radius: 99px;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 0.15s ease, background 0.15s ease;
}}
.fid-pulse {{
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22C55E;
  box-shadow:none;
}}
.fid-badge:hover {{ background: rgba(34, 197, 94, 0.24); transform: translateY(-1px); }}
body[data-theme="feishu-light"] .fid-badge {{ color: #15803D; background: #DCFCE7; }}
/* Pill-Style Modern Tabs */
.mm-tabs {{
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  margin-bottom: 22px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
  overflow-x: auto;
}}
.mm-tab {{
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  padding: 5px 12px;
  border-radius: 99px;
  white-space: nowrap;
  transition: background-color 0.16s ease;
}}
.mm-tab:hover {{ color: var(--text-main); background: rgba(255, 255, 255, 0.04); }}
.mm-tab.active {{
  color: #F8FAFC;
  background: rgba(76, 141, 255, 0.20);
  border-color: rgba(76, 141, 255, 0.42);
  font-weight: 600;
  box-shadow:none;
}}
body[data-theme="feishu-light"] .mm-tab.active,
body[data-theme="minimal-ink"] .mm-tab.active {{
  color: #1D4ED8;
  background: #DBEAFE;
  border-color: #93C5FD;
}}
{theme_css}
/* Modular Architectural Section Cards */
.mm-section {{
  margin-bottom: 20px;
  background: var(--bg-sec-card);
  background:none;
  border: 1px solid var(--border-subtle);
  box-shadow:none;
  border-radius: 13px;
  padding: 16px 20px 18px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}}
.mm-section:hover {{
  border-color: var(--sec-block-border);
}}
body[data-theme="feishu-light"] .mm-section,
body[data-theme="minimal-ink"] .mm-section {{
  box-shadow:none;
}}
.mm-section.hidden-tab, .mm-section.hidden-search {{ display: none; }}
.mm-sec-header {{
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  margin-bottom: 12px;
}}
.mm-section.collapsed .mm-sec-header {{ margin-bottom: 0; }}
.mm-sec-caret {{
  color: var(--text-muted);
  font-size: 12px;
  width: 16px;
  text-align: center;
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}}
.mm-section.collapsed .mm-sec-caret {{ transform: rotate(-90deg); }}
.mm-section.collapsed .mm-sec-body {{ display: none; }}
.mm-sec-idx {{
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--sec-title-text);
  background: var(--sec-title-bg);
  border: 1px solid var(--sec-block-border);
  padding: 1.5px 6px;
  border-radius: 5px;
}}
.mm-sec-pill {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 7px;
  background: var(--sec-title-bg);
  border: 1px solid var(--sec-block-border);
  color: var(--sec-title-text);
  font-weight: 650;
  font-size: 13.8px;
  letter-spacing: -0.01em;
  box-shadow:none;
}}
.sec-meta-count {{
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: 4px;
}}
.sec-right-tag {{
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  padding: 2px 10px;
  border-radius: 99px;
  background: var(--sec-title-bg);
  border: 1px solid var(--sec-block-border);
  color: var(--sec-title-text);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}}
/* Circuit-Rail Section Body & Luminous Callout Blocks */
.mm-sec-body {{
  margin-left: 7px;
  padding-left: 16px;
  border-left: 1.5px solid rgba(148, 163, 184, 0.14);
  display: flex;
  flex-direction: column;
  gap: 9px;
  transition: border-color 0.2s ease;
}}
.mm-section:hover .mm-sec-body {{
  border-left-color: var(--sec-block-border);
}}
.mm-callout-row {{
  display: grid;
  grid-template-columns: 12px 1fr;
  align-items: start;
  gap: 8px;
}}
.mm-rail-node {{
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid var(--sec-accent);
  background: var(--bg-card);
  margin-top: 13px;
  margin-left: 2px;
  transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}}
.mm-callout-row:hover .mm-rail-node {{
  background: var(--sec-accent);
  box-shadow:none;
  transform: scale(1.2);
}}
.mm-callout-block {{
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  background: var(--sec-block-bg);
  border: 1px solid var(--sec-block-border);
  border-left: 3.5px solid var(--sec-accent);
  box-shadow:none;
  color: var(--sec-block-text);
  padding: 7.5px 13px;
  border-radius: 8px;
  font-size: 13.2px;
  line-height: 1.62;
  transition: transform 0.15s ease, border-color 0.15s ease;
}}
.mm-callout-block:hover {{
  transform: translateX(2px);
}}
.mm-callout-inner {{ flex: 1; }}
.mm-copy-mini {{
  opacity: 0;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}}
.mm-callout-block:hover .mm-copy-mini {{ opacity: 1; }}
.mm-copy-mini:hover {{ background: rgba(76, 141, 255, 0.25); color: #fff; }}
.mm-lead-clause {{
  font-weight: 650;
  color: #FFFFFF;
}}
body[data-theme="feishu-light"] .mm-lead-clause,
body[data-theme="minimal-ink"] .mm-lead-clause {{
  color: #0F172A;
}}
.mm-quote-term {{
  font-weight: 600;
  text-decoration: underline;
  text-decoration-color: var(--sec-accent);
  text-underline-offset: 3px;
}}
.mm-num-token {{
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  font-size: 0.93em;
  font-weight: 600;
  white-space: nowrap;
  padding: 0.5px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.085);
}}
body[data-theme="feishu-light"] .mm-num-token,
body[data-theme="minimal-ink"] .mm-num-token {{
  background: rgba(15, 23, 42, 0.065);
}}
.mm-at {{
  display: inline-block;
  white-space: nowrap;
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(76, 141, 255, 0.20);
  border: 1px solid rgba(76, 141, 255, 0.32);
  color: #82B1FF;
  font-weight: 550;
  font-size: 12px;
}}
body[data-theme="feishu-light"] .mm-at {{ background: #DBEAFE; border-color: #BFDBFE; color: #1D4ED8; }}
/* Cards & Interactive Feishu Board Canvas (Exact 20px left rail match with .mm-callout-block!) */
.mm-card {{
  margin: 4px 0 6px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  box-shadow:none;
  border-radius: 10px;
  overflow: hidden;
}}
body[data-theme="feishu-light"] .mm-card,
body[data-theme="minimal-ink"] .mm-card {{
  box-shadow:none;
}}
.mm-card-header {{
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 13px;
  background: var(--bg-card-header);
  border-bottom: 1px solid var(--border-subtle);
  gap: 8px;
  flex-wrap: wrap;
}}
.mm-card-title-group {{ display: flex; align-items: center; gap: 8px; }}
.wb-badge {{
  font-size: 10.5px;
  white-space: nowrap;
  flex-shrink: 0;
  padding: 1.5px 7px;
  border-radius: 4px;
  background: rgba(6, 182, 212, 0.15);
  border: 1px solid rgba(6, 182, 212, 0.35);
  color: #22D3EE;
  font-weight: 600;
  letter-spacing: 0.01em;
}}
body[data-theme="feishu-light"] .wb-badge,
body[data-theme="minimal-ink"] .wb-badge {{ background: #CFFAFE; color: #0E7490; border-color: #67E8F9; }}
.mm-card-title {{ font-size: 12.8px; font-weight: 650; color: var(--text-main); }}
.mm-card-actions {{ display: flex; align-items: center; gap: 6px; flex-shrink: 0; }}
/* Segmented Pill Switcher */
.mm-seg-group {{
  display: inline-flex;
  background: rgba(0, 0, 0, 0.24);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
}}
body[data-theme="feishu-light"] .mm-seg-group,
body[data-theme="minimal-ink"] .mm-seg-group {{
  background: #E2E8F0;
}}
.mm-seg-btn {{
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  padding: 2.5px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}}
.mm-card.card-mode-board .mm-seg-btn.seg-board,
.mm-card.card-mode-dom .mm-seg-btn.seg-dom {{
  background: rgba(76, 141, 255, 0.24);
  color: #74A8FF;
  font-weight: 600;
  box-shadow:none;
}}
body[data-theme="feishu-light"] .mm-card.card-mode-board .mm-seg-btn.seg-board,
body[data-theme="feishu-light"] .mm-card.card-mode-dom .mm-seg-btn.seg-dom,
body[data-theme="minimal-ink"] .mm-card.card-mode-board .mm-seg-btn.seg-board,
body[data-theme="minimal-ink"] .mm-card.card-mode-dom .mm-seg-btn.seg-dom {{
  background: #FFFFFF;
  color: #1D4ED8;
}}
.mm-card-btn {{
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}}
.mm-card-btn:hover {{ color: var(--text-main); border-color: #4C8DFF; }}
.mm-card-expand {{
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
  display: inline-flex;
}}
.mm-card-expand:hover {{ color: var(--text-main); background: rgba(255, 255, 255, 0.08); }}
.mm-card-body {{ padding: 12px 14px; }}
.mm-card.card-mode-board .view-dom-content {{ display: none; }}
.mm-card.card-mode-dom .view-board-canvas {{ display: none; }}
.wb-canvas-wrap {{ position:relative; width:100%; overflow:hidden; cursor:grab; user-select:none; }}
.wb-canvas-wrap:active {{ cursor: grabbing; }}
.wb-floating-controls {{
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 3px;
  background: rgba(20, 23, 31, 0.84);
  
  padding: 3px 6px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow:none;
}}
.wb-ctrl-sep {{
  width: 1px;
  height: 12px;
  background: rgba(255, 255, 255, 0.16);
  margin: 0 2px;
}}
.wb-floating-controls button {{
  background: transparent;
  border: none;
  color: #E2E8F0;
  font-size: 11px;
  font-family: var(--font-sans);
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}}
.wb-floating-controls button:hover {{ background: rgba(76, 141, 255, 0.30); color: #fff; }}
.wb-pan-stage {{
  transform-origin: 0 0;
  transition: transform 0.05s linear;
}}
.wb-svg {{ display: block; width: 100%; height: auto; }}
.wb-node-rect {{ transition: filter 0.15s ease, stroke-width 0.15s ease; }}
.wb-node-rect:hover {{ filter: brightness(1.12); stroke-width: 2.2px; }}
#mm-panoramic-board {{
  display: none;
  margin-top: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: 12px;
  padding: 16px;
}}
#mm-panoramic-board.active {{ display: block; }}
.wb-pano-bar {{
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-subtle);
  flex-wrap: wrap;
  gap: 8px;
}}
/* Upgraded Native DOM Card Styles */
.flow-track {{ display: flex; align-items: stretch; gap: 8px; overflow-x: auto; padding-bottom: 6px; }}
.flow-step {{ flex: 1; min-width: 140px; background: var(--bg-step); border: 1px solid var(--border-card); box-shadow:none; border-radius: 8px; padding: 10px 12px; }}
.flow-step-active {{ background: rgba(245, 158, 11, 0.14); border-color: rgba(245, 158, 11, 0.55); }}
.flow-step-done {{ border-color: rgba(34, 197, 94, 0.38); }}
.flow-meta {{ font-size: 11px; color: #FBBF24; margin-bottom: 3px; font-variant-numeric: tabular-nums; font-weight: 600; }}
.flow-title {{ font-weight: 650; font-size: 12.8px; color: var(--text-main); }}
.flow-desc {{ font-size: 11.5px; color: var(--text-muted); margin-top: 4px; }}
.flow-arrow {{ display: flex; align-items: center; color: var(--text-dim); font-weight: 700; padding: 0 2px; }}
.flow-progress-track {{ height: 5px; background: rgba(148, 163, 184, 0.14); border-radius: 99px; margin-top: 10px; overflow: hidden; }}
.flow-progress-bar {{ height: 100%; background:none; border-radius: 99px; }}
.branch-container {{ display: flex; align-items: center; gap: 10px; overflow-x: auto; }}
.branch-root, .branch-hub {{ padding: 9px 13px; border-radius: 7px; font-size: 12.5px; font-weight: 650; white-space: nowrap; background: var(--bg-step); border: 1px solid var(--border-card); }}
.branch-hub {{ background: rgba(6, 182, 212, 0.16); border-color: rgba(6, 182, 212, 0.45); color: #22D3EE; }}
body[data-theme="feishu-light"] .branch-hub {{ color: #0E7490; background: #ECFEFF; }}
.branch-lanes {{ display: flex; flex-direction: column; gap: 8px; flex: 1; }}
.branch-row {{ display: flex; align-items: center; gap: 8px; }}
.branch-fork-arrow {{ color: var(--text-dim); font-weight: bold; }}
.branch-node {{ padding: 6px 11px; border-radius: 7px; font-size: 12px; background: var(--bg-step); border: 1px solid var(--border-card); white-space: nowrap; }}
.kpi-grid {{ display: flex; flex-wrap: wrap; gap: 14px; }}
.kpi-box {{
  position: relative;
  flex: 1;
  min-width: 220px;
  max-width: 360px;
  background: var(--bg-step);
  background:none;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  padding: 12px 16px;
  box-shadow:none;
}}
.kpi-box-title {{ font-size: 12px; font-weight: 550; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }}
.kpi-compare {{ display: flex; align-items: center; justify-content: space-between; gap: 12px; }}
.kpi-col {{ display: flex; flex-direction: column; }}
.kpi-sub {{ font-size: 11px; color: var(--text-dim); margin-bottom: 2px; }}
.kpi-num {{ font-family: var(--font-sans); font-variant-numeric: tabular-nums; font-size: 24px; font-weight: 750; letter-spacing: -0.03em; }}
.kpi-num-muted {{ color: var(--text-muted); font-size: 20px; }}
.kpi-num-highlight {{ color: var(--text-main); }}
.kpi-arrow {{ color: var(--text-dim); font-size: 16px; }}
.kpi-delta {{ font-family: var(--font-sans); font-variant-numeric: tabular-nums; font-size: 11.5px; font-weight: 650; padding: 2px 7px; border-radius: 99px; }}
.kpi-trend-up {{ background: rgba(34, 197, 94, 0.16); border: 1px solid rgba(34, 197, 94, 0.32); color: #4ADE80; }}
body[data-theme="feishu-light"] .kpi-trend-up {{ color: #15803D; background: #DCFCE7; }}
.mm-pillar-grid {{ display: grid; grid-template-columns: repeat(var(--grid-cols, 3), 1fr); gap: 12px; }}
.grid-col-item {{ background: var(--bg-step); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 10px 13px; box-shadow:none; }}
.grid-col-title {{ font-weight: 650; font-size: 12.8px; display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }}
.grid-dot {{ width: 8px; height: 8px; border-radius: 50%; display: inline-block; }}
.grid-col-desc {{ font-size: 12px; color: var(--text-muted); line-height: 1.55; }}
.mm-table-wrap {{ overflow-x: auto; border-radius: 7px; border: 1px solid var(--border-subtle); }}
.mm-table {{ width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }}
.mm-table th {{ background: var(--bg-card-header); color: var(--text-muted); font-weight: 600; text-align: left; padding: 8.5px 13px; border-bottom: 1px solid var(--border-card); white-space: nowrap; }}
.mm-table td {{ padding: 8px 13px; border-bottom: 1px solid var(--border-subtle); color: var(--text-main); vertical-align: middle; }}
.mm-table tr:hover td {{ background: rgba(76, 141, 255, 0.04); }}
.mm-table tr:last-child td {{ border-bottom: none; }}
.td-merged-group {{ font-weight: 650; color: var(--text-muted); border-right: 1px solid var(--border-subtle); background: rgba(148, 163, 184, 0.04); }}
.mm-badge {{ display: inline-block; padding: 1.5px 7.5px; border-radius: 5px; font-family: var(--font-sans); font-size: 11px; font-weight: 600; }}
.mm-badge-danger {{ background: rgba(239, 68, 68, 0.16); color: #F87171; border: 1px solid rgba(239, 68, 68, 0.32); }}
.mm-badge-warn {{ background: rgba(245, 158, 11, 0.16); color: #FBBF24; border: 1px solid rgba(245, 158, 11, 0.32); }}
.mm-badge-info {{ background: rgba(76, 141, 255, 0.16); color: #60A5FA; border: 1px solid rgba(76, 141, 255, 0.32); }}
body[data-theme="feishu-light"] .mm-badge-danger {{ color: #B91C1C; background: #FEE2E2; }}
body[data-theme="feishu-light"] .mm-badge-warn {{ color: #B45309; background: #FEF3C7; }}
body[data-theme="feishu-light"] .mm-badge-info {{ color: #1D4ED8; background: #DBEAFE; }}
.mm-status-lamp {{ display: inline-flex; align-items: center; gap: 6px; font-weight: 550; white-space: nowrap; }}
.lamp-dot {{ width: 8px; height: 8px; border-radius: 50%; display: inline-block; }}
.lamp-green {{ background: #22C55E; box-shadow:none; }}
.lamp-red {{ background: #EF4444; box-shadow:none; }}
.lamp-amber {{ background: #F59E0B; box-shadow:none; }}
.tl-container.tl-mode-horizontal {{ display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px; }}
.tl-mode-horizontal .tl-item {{ flex: 1; min-width: 160px; background: var(--bg-step); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 9px 12px; box-shadow:none; }}
.tl-marker {{ display: flex; align-items: center; gap: 6px; margin-bottom: 5px; min-width: 75px; }}
.tl-dot {{ width: 8px; height: 8px; border-radius: 50%; background: #64748B; }}
.tl-status-done .tl-dot {{ background: #22C55E; }}
.tl-status-active .tl-dot {{ background: #F59E0B; box-shadow:none; }}
.tl-time {{ font-family: var(--font-sans); font-variant-numeric: tabular-nums; font-size: 11.5px; font-weight: 600; color: #60A5FA; }}
.tl-title {{ font-size: 12.5px; font-weight: 650; }}
.tl-desc {{ font-size: 11.5px; color: var(--text-muted); margin-top: 3px; }}
.pc-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
.pc-box {{ background: var(--bg-step); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 11px 14px; }}
.pc-header {{ display: flex; justify-content: space-between; align-items: center; font-weight: 650; font-size: 12.8px; margin-bottom: 7px; }}
.pc-tag {{ font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid; }}
.pc-list {{ padding-left: 16px; font-size: 12px; color: var(--text-muted); display: flex; flex-direction: column; gap: 4px; }}
.pc-verdict {{ margin-top: 10px; padding: 8px 12px; border-radius: 7px; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.28); color: #4ADE80; font-size: 12.2px; font-weight: 550; display: flex; align-items: center; gap: 7px; }}
body[data-theme="feishu-light"] .pc-verdict {{ color: #15803D; background: #F0FDF4; }}
/* Interactive Action List Progress Bar */
.act-prog-header {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 9px;
  padding: 5px 10px;
  background: rgba(76, 141, 255, 0.07);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
}}
.act-prog-label {{ font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }}
.act-prog-num {{ font-family: var(--font-sans); color: #60A5FA; }}
.act-prog-track {{ flex: 1; max-width: 220px; height: 6px; background: rgba(148, 163, 184, 0.16); border-radius: 99px; overflow: hidden; }}
.act-prog-fill {{ height: 100%; background:none; border-radius: 99px; transition: width 0.25s ease; }}
.act-list {{ display: flex; flex-direction: column; gap: 6px; }}
.act-row {{ display: flex; align-items: center; gap: 9px; padding: 7px 11px; border-radius: 7px; background: var(--bg-step); border: 1px solid var(--border-subtle); transition: border-color 0.15s ease; }}
.act-row:hover {{ border-color: rgba(76, 141, 255, 0.35); }}
.act-check {{ width: 15px; height: 15px; accent-color: #22C55E; cursor: pointer; }}
.act-row.act-done .act-text {{ text-decoration: line-through; color: var(--text-dim); }}
.act-text {{ flex: 1; font-size: 12.5px; }}
.act-meta {{ display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-variant-numeric: tabular-nums; }}
.act-due {{ color: var(--text-muted); font-family: var(--font-sans); font-size: 11px; }}
.qd-box {{ border-left: 3.5px solid #F59E0B; background: rgba(245, 158, 11, 0.06); border-radius: 0 8px 8px 0; padding: 8px 14px; }}
.qd-top {{ display: flex; align-items: center; gap: 6px; font-size: 12px; color: #FBBF24; margin-bottom: 4px; }}
.qd-role {{ color: var(--text-dim); font-size: 11.5px; }}
.qd-text {{ font-size: 13.8px; font-weight: 650; color: var(--text-main); }}
.qd-impact {{ font-size: 11.5px; color: var(--text-muted); margin-top: 5px; }}
.fn-list {{ display: flex; flex-direction: column; gap: 9px; }}
.fn-top {{ display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }}
.fn-val {{ font-family: var(--font-sans); font-variant-numeric: tabular-nums; font-weight: 650; }}
.fn-note {{ color: var(--text-dim); font-size: 11px; margin-left: 6px; }}
.fn-track {{ height: 8px; background: rgba(148, 163, 184, 0.14); border-radius: 99px; overflow: hidden; }}
.fn-bar {{ height: 100%; border-radius: 99px; }}
.mm-modal {{ display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.76);  z-index: 999; align-items: center; justify-content: center; padding: 24px; }}
.mm-modal.open {{ display: flex; }}
.mm-modal-content {{ max-width: 95vw; max-height: 90vh; width: 860px; overflow: auto; background: var(--bg-surface); border: 1px solid var(--border-card); border-radius: 14px; padding: 22px; box-shadow:none; }}
.code-pre {{
  background: #0D0F14;
  color: #E2E8F0;
  padding: 13px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 12px;
  max-height: 260px;
  overflow: auto;
  margin-top: 8px;
  border: 1px solid var(--border-card);
}}
@media (max-width: 1024px) {{
  .mm-workspace {{ grid-template-columns: 1fr; }}
  .mm-sidebar {{ position: static; max-height: none; }}
}}
@media (max-width: 768px) {{
  body {{ padding: 12px 10px 48px; }}
  .mm-container {{ padding: 18px 16px 28px; }}
  .mm-top-bar {{ flex-direction: column; }}
  .mm-title {{ white-space: normal; }}
  .mm-meta-chip {{ white-space: normal; }}
  .pc-grid, .mm-pillar-grid {{ grid-template-columns: 1fr; }}
}}
/* finesse · register=product · A=ink+petrol · B=650/400 · C=decision-ledger
 * D=feedback-only · E=flat-native · SOUL=5 SPECTACLE=1 DENSITY=6
 * taste: achromatic-ledger, seed=2073092189; native board constraints apply. */
body[data-theme="feishu-light"], body[data-theme="minimal-ink"] {{
  --bg-page:#f2f4f5; --bg-surface:#e8edee; --bg-sec-card:#fcfdfd;
  --bg-card:#fcfdfd; --bg-card-header:#e8edee; --wb-canvas-bg:#f2f4f5;
  --text-main:#202e34; --text-muted:#52656c; --text-dim:#52656c;
  --border-subtle:transparent; --border-card:transparent;
}}
body {{ background-image:none; font-size:16px; }}
.mm-sidebar, .mm-section, .mm-card, .mm-header, .mm-meta-chip, .mm-sec-pill,
.mm-callout-block, .mm-tab, .mm-btn, .mm-seg-group, .mm-seg-btn,
.wb-floating-controls {{ box-shadow:none; background-image:none !important;  }}
.mm-workspace {{ max-width:1520px; gap:32px; padding:32px; }}
.mm-sidebar {{ border:0; border-radius:8px; }}
.mm-section {{ border:0; border-radius:8px; padding:24px; margin-bottom:32px; }}
.mm-section:hover {{ box-shadow:none; }}
.mm-section .mm-sec-pill {{ background:none; border:0; color:var(--text-main); font-size:22px; font-weight:650; padding:0; }}
.mm-sec-idx, .mm-rail-node {{ display:none; }}
.mm-sec-header {{ gap:8px; }}
.mm-sec-body {{ padding-left:0; margin-left:0; border-left:0; }}
.mm-callout-row {{ display:flex; padding-left:0; margin:12px 0; width:100%; }}
.mm-callout-block {{ flex:1; min-width:0; margin-left:0; padding:16px; border:0; background:var(--bg-card-header); }}
.mm-callout-inner {{ font-size:16px; line-height:1.65; }}
.mm-card {{ margin:24px 0; border:0; border-radius:8px; }}
.mm-card-title {{ font-size:18px; }}
.mm-card-header {{ padding:16px; gap:12px; }}
.mm-card-body {{ padding:8px; }}
.mm-num-token {{ font-family:var(--font-sans); padding:0; background:none !important; }}
.mm-quote-term {{ text-decoration:none; }}
.mm-meta-chip {{ border:0; background:none; padding:0; font-size:14px; }}
.mm-tab {{ border-radius:6px; font-size:14px; }}
body[data-theme="feishu-light"] .mm-tab.active {{ color:#202e34; background:#dce4e6; border-color:transparent; }}
.wb-badge {{ display:none; }}
.mm-eyebrow, .mm-exec-bar, .fid-pulse {{ display:none; }}
.mm-exec-summary {{ background:var(--bg-card-header); border:0; box-shadow:none; }}
.mm-exec-label {{ color:var(--text-main); font:600 16px var(--font-sans); letter-spacing:0; }}
.mm-exec-text {{ color:var(--text-main); font-size:16px; }}
.sb-stat-num, .sb-stat-label, .sb-brand-badge, .mm-exec-text, .mm-sec-count, .toc-item {{ font-family:var(--font-sans); }}
.sb-stat-num {{ color:var(--text-main) !important; }}
.mm-container {{ min-width:0; }}
.wb-canvas-wrap {{ border:0; border-radius:8px; background:#f2f4f5; }}
.wb-floating-controls {{ position:relative; top:auto; right:auto; margin:8px; background:#e8edee; border:0; border-radius:6px; flex-wrap:wrap; justify-content:flex-end; max-width:calc(100% - 16px); }}
.wb-floating-controls button {{ min-width:44px; min-height:44px; color:#202e34; background:none; font-size:14px; }}
.mm-copy-mini, .mm-card-btn, .mm-card-expand, .mm-seg-btn {{ min-height:36px; }}
button:focus-visible, input:focus-visible, select:focus-visible {{ outline:2px solid #176b78; outline-offset:3px; }}
@media (max-width:720px) {{
  .mm-workspace {{ display:block; padding:16px; width:100%; max-width:100vw; }}
  .mm-sidebar {{ display:none; }}
  .mm-workspace.mobile-nav-open .mm-sidebar {{ display:flex; margin-bottom:16px; width:100%; }}
  #btn-show-sb {{ display:inline-flex !important; }}
  .mm-container {{ width:100%; padding:16px; overflow:hidden; }}
  .mm-title-row {{ flex-wrap:wrap; }}
  .mm-toolbar {{ width:100%; flex-shrink:1; }}
  .mm-sec-header {{ flex-wrap:wrap; }}
  .mm-section .mm-sec-pill {{ min-width:0; max-width:100%; white-space:normal; }}
  .mm-sec-pill span {{ white-space:normal; overflow-wrap:anywhere; }}
  .mm-exec-summary {{ flex-direction:column; align-items:flex-start; padding:16px; }}
  .mm-main, .mm-content, .mm-section {{ min-width:0; }}
  .mm-section {{ padding:16px; }}
  .mm-card-header {{ align-items:flex-start; }}
  .mm-card-actions {{ flex-wrap:wrap; width:100%; }}
  .mm-card-title {{ overflow-wrap:anywhere; }}
  .mm-section .mm-sec-pill {{ font-size:20px; }}
}}
@media (prefers-reduced-motion:reduce) {{ *, *::before, *::after {{ scroll-behavior:auto !important; animation:none !important; transition:none !important; }} }}

</style>
</head>
<body data-theme="{esc(theme)}">
<div class="mm-workspace" id="mm-workspace">
  <!-- Left Sticky Glass Navigation & Telemetry Sidebar -->
  <aside class="mm-sidebar" aria-label="章节导航与工作台统计">
    <div class="sb-brand">
      <span class="sb-brand-badge">{get_svg("compass", 14)} <span>会议纪要</span></span>
      <button type="button" class="mm-card-btn" onclick="toggleSidebar()" title="收起侧边导航栏">⇤ 宽屏</button>
    </div>
    <div class="sb-search-wrap">
      <span class="sb-search-icon"></span>
      <input type="search" id="mm-search-input" class="sb-search-input" placeholder="检索结论 / @责任人 / 指标 (⌘K)" oninput="filterBySearch(this.value)">
    </div>
    <div class="sb-bento-stats">
      <div class="sb-stat-card">
        <span class="sb-stat-num">{len(sections):02d}</span>
        <span class="sb-stat-lbl">核心议题模块</span>
      </div>
      <div class="sb-stat-card">
        <span class="sb-stat-num" style="color:#38BDF8">{total_cards:02d}</span>
        <span class="sb-stat-lbl">嵌入式飞书画板</span>
      </div>
      <div class="sb-stat-card">
        <span class="sb-stat-num" style="color:#1F2329">{wb_meta['total_nodes']}</span>
        <span class="sb-stat-lbl">2D 矢量节点</span>
      </div>
      <div class="sb-stat-card">
        <span class="sb-stat-num" style="color:#4ADE80">{fid_status}</span>
        <span class="sb-stat-lbl">锚点保真 ({fid_cnt}项)</span>
      </div>
    </div>
    <div class="sb-toc-title">议题目录导航 (点击直达)</div>
    <nav class="sb-toc-list" id="sb-toc-list">
      {"".join(toc_items_list)}
    </nav>
  </aside>

  <!-- Main Executive Document & Whiteboard Canvas -->
  <div class="mm-container">
    <header class="mm-top-bar">
      
      <div class="mm-title-row">
        <h1 class="mm-title">{esc(title)}</h1>
        <div class="mm-toolbar">
          <button class="mm-btn" id="btn-show-sb" style="display:none" onclick="toggleSidebar()">⇥ 展开目录</button>
          <button class="mm-btn" id="btn-pano-board" onclick="togglePanoramicBoard()">全景画板 ({wb_meta['total_nodes']}节点)</button>
          <button class="mm-btn" id="btn-all-board" onclick="toggleAllCardsBoardMode()"> 全部切换画板/表格</button>
          <select class="mm-select" onchange="document.body.setAttribute('data-theme', this.value)" title="切换视觉主题">
            <option value="feishu-dark" {"selected" if theme == "feishu-dark" else ""}>深色</option>
            <option value="feishu-light" {"selected" if theme == "feishu-light" else ""}>浅色</option>
            <option value="ocean-glass" {"selected" if theme == "ocean-glass" else ""}>海洋深色</option>
            <option value="minimal-ink" {"selected" if theme == "minimal-ink" else ""}>墨色</option>
          </select>
          <button class="mm-btn" onclick="toggleAllSections()">折叠/展开</button>
        </div>
      </div>
      {meta_chips_html}
    </header>
    {summary_html}
    <nav class="mm-tabs">{tabs_html}</nav>

    <!-- Panoramic Full-Meeting Feishu Whiteboard Canvas -->
    <div id="mm-panoramic-board" data-full-payload="{full_wb_json_escaped}">
      <div class="wb-pano-bar">
        <div>
          <strong style="color:#1F2329">画板总览 (支持鼠标拖拽平移 + Ctrl滚轮缩放 + 一键导图)</strong>
          <span style="font-size:12px;color:var(--text-muted);margin-left:8px">动态自适应排版 {wb_meta['total_nodes']} 个节点 ({wb_meta['canvas_width']}×{wb_meta['canvas_height']}px，零截断)</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="mm-btn" onclick="copyFullBoardPayload()"> 复制全景画板 OpenAPI JSON</button>
          <button class="mm-btn" onclick="togglePanoramicBoard()">返回图文纪要视图</button>
        </div>
      </div>
      <!-- taste-skill-ignore: preserve original meeting RAG and status symbols -->{full_wb_svg}
    </div>

    <main id="mm-main">
      <!-- taste-skill-ignore: preserve original meeting RAG and status symbols -->{"".join(sections_html_list)}
    </main>
  </div>
</div>

<div id="mm-modal" class="mm-modal" onclick="if(event.target===this)this.classList.remove('open')">
  <div id="mm-modal-box" class="mm-modal-content"></div>
</div>

<script>
function toggleSidebar() {{
  const ws = document.getElementById('mm-workspace');
  const btn = document.getElementById('btn-show-sb');
  if (window.matchMedia('(max-width:720px)').matches) {{
    const open = ws.classList.toggle('mobile-nav-open');
    if (open) document.querySelector('.mm-sidebar').scrollIntoView({{block:'start'}});
    return;
  }}
  const collapsed = ws.classList.toggle('sidebar-collapsed');
  if (btn) btn.style.display = collapsed ? 'inline-flex' : 'none';
}}
function scrollToSection(e, secId) {{
  e.preventDefault();
  const el = document.getElementById(secId);
  if (el) {{
    el.classList.remove('collapsed');
    el.scrollIntoView({{behavior: 'smooth', block: 'start'}});
  }}
  document.querySelectorAll('.toc-item').forEach(a => a.classList.toggle('active', a.getAttribute('data-target') === secId));
}}
function filterBySearch(query) {{
  const q = (query || '').trim().toLowerCase();
  document.querySelectorAll('.mm-section').forEach(sec => {{
    if (!q) {{
      sec.classList.remove('hidden-search');
      return;
    }}
    const match = sec.innerText.toLowerCase().includes(q);
    sec.classList.toggle('hidden-search', !match);
    if (match) sec.classList.remove('collapsed');
  }});
}}
window.addEventListener('keydown', e => {{
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {{
    e.preventDefault();
    const inp = document.getElementById('mm-search-input');
    if (inp) inp.focus();
  }}
}});
function copyCalloutText(btn) {{
  const txt = btn.getAttribute('data-copy') || '';
  navigator.clipboard.writeText(txt);
  const old = btn.textContent;
  btn.textContent = '已复制';
  setTimeout(() => {{ btn.textContent = old; }}, 1200);
}}
function updateActionProgress(chk) {{
  const row = chk.closest('.act-row');
  row.classList.toggle('act-done', chk.checked);
  const card = chk.closest('.view-dom-content');
  if (!card) return;
  const all = card.querySelectorAll('.act-check');
  const done = card.querySelectorAll('.act-check:checked');
  const pct = all.length ? Math.round((done.length / all.length) * 100) : 0;
  const numEl = card.querySelector('.act-prog-num');
  const fillEl = card.querySelector('.act-prog-fill');
  if (numEl) numEl.textContent = `${{done.length}}/${{all.length}} (${{pct}}%)`;
  if (fillEl) fillEl.style.width = `${{pct}}%`;
}}
function filterTab(btn, tabName) {{
  document.querySelectorAll('.mm-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.mm-section').forEach(sec => {{
    if (tabName === '全部' || sec.getAttribute('data-tab') === tabName) {{
      sec.classList.remove('hidden-tab');
    }} else {{
      sec.classList.add('hidden-tab');
    }}
  }});
}}
let allCollapsed = false;
function toggleAllSections() {{
  allCollapsed = !allCollapsed;
  document.querySelectorAll('.mm-section').forEach(s => {{
    s.classList.toggle('collapsed', allCollapsed);
  }});
}}
function setCardMode(btn, mode) {{
  const card = btn.closest('.mm-card');
  const toBoard = (mode === 'board');
  card.classList.toggle('card-mode-board', toBoard);
  card.classList.toggle('card-mode-dom', !toBoard);
}}
let forceAllBoard = false;
function toggleAllCardsBoardMode() {{
  forceAllBoard = !forceAllBoard;
  const btn = document.getElementById('btn-all-board');
  if (btn) btn.classList.toggle('active-mode', forceAllBoard);
  document.querySelectorAll('.mm-card').forEach(card => {{
    card.classList.toggle('card-mode-board', forceAllBoard);
    card.classList.toggle('card-mode-dom', !forceAllBoard);
  }});
}}
function togglePanoramicBoard() {{
  const pano = document.getElementById('mm-panoramic-board');
  const main = document.getElementById('mm-main');
  const btn = document.getElementById('btn-pano-board');
  const isOpen = pano.classList.toggle('active');
  if (btn) btn.classList.toggle('active-mode', isOpen);
  main.style.display = isOpen ? 'none' : 'block';
}}
function copyFullBoardPayload() {{
  const raw = document.getElementById('mm-panoramic-board').getAttribute('data-full-payload');
  navigator.clipboard.writeText(raw);
  alert('已复制整场会议的飞书画板 OpenAPI 2D 节点树 JSON！');
}}
function showFidelityAudit(btn) {{
  const data = JSON.parse(btn.getAttribute('data-audit') || '{{}}');
  const box = document.getElementById('mm-modal-box');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="font-size:15px;color:#4ADE80"> 代码级无损事实锚点核验报告 (Fidelity Verifier)</h3>
      <button class="mm-btn" onclick="document.getElementById('mm-modal').classList.remove('open')">关闭</button>
    </div>
    <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px">以下硬性事实锚点已通过正则交叉比对，100% 锁定在纪要与画板节点中：</p>
    <pre class="code-pre">${{JSON.stringify(data, null, 2)}}</pre>
  `;
  document.getElementById('mm-modal').classList.add('open');
}}
function showBoardCode(btn) {{
  const nodesJson = btn.getAttribute('data-nodes');
  const mermaidCode = btn.getAttribute('data-mermaid');
  const box = document.getElementById('mm-modal-box');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="font-size:15px;color:#22D3EE"> 飞书画板直绘 API 载荷与 Mermaid 语法</h3>
      <button class="mm-btn" onclick="document.getElementById('mm-modal').classList.remove('open')">关闭</button>
    </div>
    <p style="font-size:12px;color:var(--text-muted)">方式一：在飞书画板中选择「语法绘图 / Mermaid」，粘贴以下语法直接生成可拖拽原生节点：</p>
    <pre class="code-pre">${{mermaidCode}}</pre>
    <p style="font-size:12px;color:var(--text-muted);margin-top:12px">方式二：调用飞书开放平台 <code>POST /open-apis/board/v1/whiteboards/:whiteboard_id/nodes</code> 直接绘制 2D 坐标节点：</p>
    <pre class="code-pre">${{nodesJson}}</pre>
  `;
  document.getElementById('mm-modal').classList.add('open');
}}
function zoomCard(btn) {{
  const card = btn.closest('.mm-card').cloneNode(true);
  const box = document.getElementById('mm-modal-box');
  box.innerHTML = '';
  box.appendChild(card);
  document.getElementById('mm-modal').classList.add('open');
}}
/* Scroll-Spy IntersectionObserver for Sidebar TOC */
if ('IntersectionObserver' in window) {{
  const obs = new IntersectionObserver(entries => {{
    entries.forEach(en => {{
      if (en.isIntersecting) {{
        const id = en.target.id;
        document.querySelectorAll('.toc-item').forEach(a => {{
          a.classList.toggle('active', a.getAttribute('data-target') === id);
        }});
      }}
    }});
  }}, {{ rootMargin: '-15% 0px -70% 0px' }});
  document.querySelectorAll('.mm-section').forEach(sec => obs.observe(sec));
}}

/* Interactive Canvas Pan & Zoom Controller */
let panState = null;
function applyStageTransform(stage) {{
  const s = parseFloat(stage.getAttribute('data-scale') || '1');
  const tx = parseFloat(stage.getAttribute('data-tx') || '0');
  const ty = parseFloat(stage.getAttribute('data-ty') || '0');
  stage.style.transform = `translate(${{tx}}px, ${{ty}}px) scale(${{s}})`;
}}
function startPan(e, wrap) {{
  if (e.target.closest('.wb-floating-controls')) return;
  const stage = wrap.querySelector('.wb-pan-stage');
  panState = {{
    stage,
    startX: e.clientX - parseFloat(stage.getAttribute('data-tx') || '0'),
    startY: e.clientY - parseFloat(stage.getAttribute('data-ty') || '0')
  }};
}}
window.addEventListener('mousemove', e => {{
  if (!panState) return;
  const tx = e.clientX - panState.startX;
  const ty = e.clientY - panState.startY;
  panState.stage.setAttribute('data-tx', tx);
  panState.stage.setAttribute('data-ty', ty);
  applyStageTransform(panState.stage);
}});
window.addEventListener('mouseup', () => {{ panState = null; }});
function wheelZoom(e, wrap) {{
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const stage = wrap.querySelector('.wb-pan-stage');
  let s = parseFloat(stage.getAttribute('data-scale') || '1');
  s = Math.min(3.0, Math.max(0.4, s * (e.deltaY < 0 ? 1.12 : 0.89)));
  stage.setAttribute('data-scale', s.toFixed(2));
  applyStageTransform(stage);
}}
function stepZoom(btn, factor) {{
  const stage = btn.closest('.wb-canvas-wrap').querySelector('.wb-pan-stage');
  let s = parseFloat(stage.getAttribute('data-scale') || '1');
  s = Math.min(3.0, Math.max(0.4, s * factor));
  stage.setAttribute('data-scale', s.toFixed(2));
  applyStageTransform(stage);
}}
function resetZoom(btn) {{
  const stage = btn.closest('.wb-canvas-wrap').querySelector('.wb-pan-stage');
  stage.setAttribute('data-scale', '1');
  stage.setAttribute('data-tx', '0');
  stage.setAttribute('data-ty', '0');
  applyStageTransform(stage);
}}

/* 1-Click Export SVG & 2x Retina PNG (Theme-Aware Computed Style Serialization) */
function cloneSvgWithComputedTheme(svg) {{
  const clone = svg.cloneNode(true);
  const origEls = svg.querySelectorAll('rect, text, path, circle, line');
  const cloneEls = clone.querySelectorAll('rect, text, path, circle, line');
  origEls.forEach((el, i) => {{
    const cs = window.getComputedStyle(el);
    if (cs.fill && cs.fill !== 'none' && !cs.fill.startsWith('url(')) {{
      cloneEls[i].setAttribute('fill', cs.fill);
    }}
    if (cs.stroke && cs.stroke !== 'none') {{
      cloneEls[i].setAttribute('stroke', cs.stroke);
    }}
  }});
  return clone;
}}
function exportBoardSvg(btn) {{
  const wrap = btn.closest('.wb-canvas-wrap');
  const svg = cloneSvgWithComputedTheme(wrap.querySelector('svg'));
  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svg);
  const blob = new Blob([source], {{type: 'image/svg+xml;charset=utf-8'}});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'feishu_board_card.svg';
  a.click();
  URL.revokeObjectURL(url);
}}
function exportBoardPng(btn) {{
  const wrap = btn.closest('.wb-canvas-wrap');
  const origSvg = wrap.querySelector('svg');
  const svg = cloneSvgWithComputedTheme(origSvg);
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svg);
  const vb = origSvg.viewBox.baseVal;
  const w = vb.width || 800;
  const h = vb.height || 300;
  const img = new Image();
  const blob = new Blob([svgStr], {{type: 'image/svg+xml;charset=utf-8'}});
  const url = URL.createObjectURL(blob);
  img.onload = function() {{
    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'feishu_board_2x.png';
    a.click();
  }};
  img.src = url;
}}
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# 7. Feishu-Flavored Markdown (.md) Compiler
# ---------------------------------------------------------------------------
def compile_markdown(data: Dict[str, Any]) -> str:
    title = data.get("title") or data.get("t", "智能会议纪要")
    subtitle = data.get("subtitle") or data.get("sub", "")
    summary = data.get("summary") or data.get("sum", "")
    sections = data.get("sections") or data.get("sec", [])

    lines = [f"# {title}", ""]
    if subtitle:
        lines.append(f"> {subtitle}")
        lines.append("")
    if summary:
        lines.append(f"> 💡 **核心摘要**：{summary}")
        lines.append("")

    for idx, sec in enumerate(sections):
        stitle = sec.get("title") or sec.get("t", f"议题 {idx + 1}")
        scolor = sec.get("color") or sec.get("c", "blue")
        emoji = COLOR_THEMES.get(scolor, COLOR_THEMES["blue"])["emoji"]
        lines.append(f"## {emoji} {stitle}")
        lines.append("")

        items = sec.get("items") or sec.get("b", [])
        for i_idx, item in enumerate(items):
            if isinstance(item, str):
                lines.append(f"> - {item}")
                lines.append("")
            elif isinstance(item, dict) and "type" not in item:
                txt = item.get("text") or item.get("t", "")
                tag = f" `{item['tag']}`" if item.get("tag") else ""
                lines.append(f"> - {txt}{tag}")
                lines.append("")
            elif isinstance(item, dict):
                norm_item = normalize_card_schema(item)
                ctype = norm_item.get("type", "table")
                ctitle = norm_item.get("title", "")
                if ctitle:
                    lines.append(f"** [飞书画板] {ctitle}**")
                _, _, _, m_code = layout_card_to_board_nodes(norm_item, id_prefix=f"s{idx}_c{i_idx}")
                if ctype in ("flow", "branch", "timeline"):
                    lines.append("```mermaid")
                    lines.append(m_code)
                    lines.append("```")
                elif ctype == "kpi":
                    for m in norm_item.get("metrics", []):
                        if m.get("from"):
                            lines.append(f"- **{m.get('label','指标')}**：`{m.get('from')}` ➔ **`{m.get('to')}`** ({m.get('delta','')})")
                        else:
                            lines.append(f"- **{m.get('label','指标')}**：**`{m.get('to')}`** ({m.get('delta','')})")
                elif ctype == "grid":
                    cols = norm_item.get("items", [])
                    headers = [c.get("t", "") for c in cols]
                    descs = [c.get("d", "") for c in cols]
                    if headers:
                        lines.append("| " + " | ".join(headers) + " |")
                        lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
                        lines.append("| " + " | ".join(descs) + " |")
                elif ctype in ("table", "status-table"):
                    headers = norm_item.get("headers", [])
                    rows = norm_item.get("rows", [])
                    if headers:
                        lines.append("| " + " | ".join(str(h) for h in headers) + " |")
                        lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
                        for r in rows:
                            lines.append("| " + " | ".join(str(c) for c in r) + " |")
                elif ctype == "action-list":
                    for act in norm_item.get("actions", []):
                        chk = "[x]" if act.get("s") == "done" else "[ ]"
                        lines.append(f"- {chk} **{act.get('p','P1')}** {act.get('t','')} — {act.get('owner','')} (📅 {act.get('due','')})")
                elif ctype == "pros-cons":
                    left = norm_item.get("left", {})
                    right = norm_item.get("right", {})
                    lines.append(f"- **{left.get('t','方案A')}**：{'; '.join(left.get('items',[]))}")
                    lines.append(f"- **{right.get('t','方案B')}**：{'; '.join(right.get('items',[]))}")
                    if norm_item.get("verdict"):
                        lines.append(f"- **✅ 最终决议**：{norm_item['verdict']}")
                elif ctype == "quote-decision":
                    lines.append(f"> 🏆 **{norm_item.get('speaker','决议')}**：{norm_item.get('text','')}")
                elif ctype == "risk-matrix":
                    for r in norm_item.get("risks", []):
                        lines.append(f"- ⚠️ **[{r.get('level','med').upper()}] {r.get('risk','')}** ➔ 预案：{r.get('mitigation','')} ({r.get('owner','')})")
                elif ctype == "funnel-metric":
                    for b in norm_item.get("bars", []):
                        lines.append(f"- **{b.get('label','')}**：`{b.get('val','')}`")
                lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile compact JSON meeting minutes DSL v2.0.")
    parser.add_argument("input", nargs="+", help="Path(s) to input JSON DSL file(s) (pass multiple files to Map-Reduce merge)")
    parser.add_argument("-o", "--output", default="meeting_minutes.html", help="Output HTML file path")
    parser.add_argument("--md", default="", help="Optional output Markdown (.md) file path")
    parser.add_argument("--board", default="", help="Optional output Feishu Board OpenAPI payload (.json) path")
    parser.add_argument("--source", default="", help="Optional raw meeting transcript file for 100% Fidelity Anchor Verification")
    args = parser.parse_args()

    loaded_chunks: List[Dict[str, Any]] = []
    for p_str in args.input:
        in_path = pathlib.Path(p_str)
        if not in_path.exists():
            print(f"Error: Input file not found: {in_path}", file=sys.stderr)
            sys.exit(1)
        loaded_chunks.append(load_and_repair_json(in_path.read_text(encoding="utf-8")))

    data = merge_dsl_chunks(loaded_chunks) if len(loaded_chunks) > 1 else loaded_chunks[0]

    source_text = ""
    if args.source and pathlib.Path(args.source).exists():
        source_text = pathlib.Path(args.source).read_text(encoding="utf-8")

    fidelity_report = verify_fidelity(data, source_text=source_text)
    print(
        f"[FIDELITY AUDIT] Locked {fidelity_report['total_locked']} hard anchors "
        f"(source retention: {fidelity_report['retention_pct']}%)" if source_text else
        f"[ANCHOR INVENTORY] {fidelity_report['total_locked']} anchors extracted; source transcript not supplied"
    )
    if fidelity_report.get("missing"):
        print(f"[WARNING] Missing anchors from source transcript: {fidelity_report['missing']}", file=sys.stderr)

    full_board = compile_full_meeting_whiteboard(data)

    out_html_path = pathlib.Path(args.output)
    out_html_path.parent.mkdir(parents=True, exist_ok=True)
    out_html_path.write_text(compile_html(data, full_board, fidelity_report), encoding="utf-8")
    print(f"[OK] Compiled HTML + Dynamic CJK Whiteboard Canvas -> {out_html_path}")

    if args.md:
        out_md_path = pathlib.Path(args.md)
        out_md_path.parent.mkdir(parents=True, exist_ok=True)
        out_md_path.write_text(compile_markdown(data), encoding="utf-8")
        print(f"[OK] Compiled Markdown -> {out_md_path}")

    if args.board:
        out_board_path = pathlib.Path(args.board)
        out_board_path.parent.mkdir(parents=True, exist_ok=True)
        export_obj = dict(full_board)
        export_obj["full_whiteboard_payload"] = export_obj.pop("feishu_openapi_clean_payload")
        out_board_path.write_text(json.dumps(export_obj, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[OK] Compiled Feishu Board OpenAPI 2D Nodes -> {out_board_path}")


if __name__ == "__main__":
    main()
