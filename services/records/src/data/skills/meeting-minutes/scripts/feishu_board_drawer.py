#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Native meeting board layout and self-built Feishu bot application export.
Local compilation is credential-free; remote writes require App ID / App Secret.
"""

import argparse
import json
import os
import pathlib
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# 1. Color Mapping for Feishu Whiteboard Nodes & Docx Callout Blocks
# ---------------------------------------------------------------------------
BOARD_PALETTE: Dict[str, Dict[str, Any]] = {
    "blue":    {"fill": "#1E2D4D", "border": "#4C8DFF", "text": "#E2ECFF", "accent": "#4C8DFF", "docx_bg": 5,  "docx_border": 5},
    "amber":   {"fill": "#422C18", "border": "#F59E0B", "text": "#FEF3C7", "accent": "#FBBF24", "docx_bg": 2,  "docx_border": 2},
    "green":   {"fill": "#163B28", "border": "#22C55E", "text": "#DCFCE7", "accent": "#4ADE80", "docx_bg": 4,  "docx_border": 4},
    "rose":    {"fill": "#471C2B", "border": "#F43F5E", "text": "#FFE4E6", "accent": "#FB7185", "docx_bg": 1,  "docx_border": 1},
    "cyan":    {"fill": "#143842", "border": "#06B6D4", "text": "#CFFAFE", "accent": "#22D3EE", "docx_bg": 5,  "docx_border": 5},
    "indigo":  {"fill": "#252754", "border": "#6366F1", "text": "#E0E7FF", "accent": "#818CF8", "docx_bg": 6,  "docx_border": 6},
    "purple":  {"fill": "#361D4F", "border": "#A855F7", "text": "#F3E8FF", "accent": "#C084FC", "docx_bg": 6,  "docx_border": 6},
    "emerald": {"fill": "#123B31", "border": "#10B981", "text": "#D1FAE5", "accent": "#34D399", "docx_bg": 4,  "docx_border": 4},
    "coral":   {"fill": "#472316", "border": "#F97316", "text": "#FFEDD5", "accent": "#FB923C", "docx_bg": 2,  "docx_border": 2},
    "slate":   {"fill": "#262F3F", "border": "#94A3B8", "text": "#F1F5F9", "accent": "#CBD5E1", "docx_bg": 7,  "docx_border": 7},
    "gold":    {"fill": "#3F3312", "border": "#EAB308", "text": "#FEF9C3", "accent": "#FACC15", "docx_bg": 3,  "docx_border": 3},
    "crimson": {"fill": "#4C1919", "border": "#EF4444", "text": "#FEE2E2", "accent": "#F87171", "docx_bg": 1,  "docx_border": 1},
}


# ---------------------------------------------------------------------------
# 2. JSON Auto-Repair & Schema Alias Normalizer (Zero-Failure Tolerance)
# ---------------------------------------------------------------------------
def load_and_repair_json(raw_text: str) -> Dict[str, Any]:
    """
    Resiliently parse JSON DSL even if the LLM wrapped it in markdown fences,
    left trailing commas, or included unescaped newlines inside strings.
    """
    cleaned = raw_text.strip()
    # Strip markdown ```json ... ``` fences if present
    cleaned = re.sub(r"^```(?:json|javascript)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    # Remove trailing commas before } or ]
    cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # Fallback: extract first { ... } block
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            sub = re.sub(r",\s*([}\]])", r"\1", cleaned[start : end + 1])
            return json.loads(sub)
        raise


def normalize_card_schema(card: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize common LLM field name variations so cards never render blank.
    """
    c = dict(card)
    ctype = str(c.get("type", "table")).lower().strip()
    type_aliases = {
        "process": "flow",
        "pipeline": "flow",
        "steps": "flow",
        "tree": "branch",
        "topology": "branch",
        "architecture": "branch",
        "metric": "kpi",
        "metrics": "kpi",
        "delta": "kpi",
        "columns": "grid",
        "pillars": "grid",
        "rag": "status-table",
        "status": "status-table",
        "status_table": "status-table",
        "roadmap": "timeline",
        "schedule": "timeline",
        "gantt": "timeline",
        "compare": "pros-cons",
        "pros_cons": "pros-cons",
        "decision": "pros-cons",
        "todo": "action-list",
        "actions": "action-list",
        "action_list": "action-list",
        "quote": "quote-decision",
        "quote_decision": "quote-decision",
        "risk": "risk-matrix",
        "risks": "risk-matrix",
        "risk_matrix": "risk-matrix",
        "funnel": "funnel-metric",
        "funnel_metric": "funnel-metric",
    }
    ctype = type_aliases.get(ctype, ctype)
    c["type"] = ctype

    # Normalize list payload keys across card types
    generic_list = c.get("items") or c.get("list") or c.get("data") or []
    if ctype == "flow" and "steps" not in c:
        c["steps"] = c.get("events") or generic_list
    elif ctype == "kpi" and "metrics" not in c:
        c["metrics"] = generic_list
    elif ctype == "timeline" and "events" not in c:
        c["events"] = c.get("steps") or generic_list
    elif ctype == "action-list" and "actions" not in c:
        c["actions"] = c.get("todos") or c.get("tasks") or generic_list
    elif ctype == "risk-matrix" and "risks" not in c:
        c["risks"] = generic_list
    elif ctype == "funnel-metric" and "bars" not in c:
        c["bars"] = c.get("steps") or generic_list

    return c


# ---------------------------------------------------------------------------
# 3. CJK-Aware Visual Text Measurement & Dynamic Box Height Calculator
# ---------------------------------------------------------------------------
def char_em_width(ch: str) -> float:
    """Return visual width in em units (CJK/Fullwidth = 1.0, ASCII = 0.56)."""
    if ord(ch) < 128:
        return 0.56
    eaw = unicodedata.east_asian_width(ch)
    return 1.0 if eaw in ("W", "F") else 0.75


def wrap_text_cjk(
    text: str,
    box_width: float,
    font_size: int = 12,
    pad_x: float = 22.0,
) -> List[str]:
    """
    Wrap text into multiple lines using accurate CJK pixel width calculation.
    Zero truncation: preserves 100% of characters.
    """
    if not text:
        return []
    avail_px = max(36.0, box_width - pad_x)
    max_em = avail_px / max(8.0, float(font_size))

    wrapped: List[str] = []
    for raw_line in str(text).split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        cur_chars: List[str] = []
        cur_em = 0.0
        for ch in line:
            w = char_em_width(ch)
            if cur_em + w > max_em and cur_chars:
                wrapped.append("".join(cur_chars))
                cur_chars = [ch]
                cur_em = w
            else:
                cur_chars.append(ch)
                cur_em += w
        if cur_chars:
            wrapped.append("".join(cur_chars))
    return wrapped or [""]


def measure_box_height(
    text: str,
    box_width: float,
    font_size: int = 12,
    min_height: float = 38.0,
    pad_x: float = 22.0,
    pad_y: float = 16.0,
    line_height_ratio: float = 1.42,
) -> Tuple[List[str], float]:
    """Return `(wrapped_lines, calculated_height)` with zero character loss."""
    lines = wrap_text_cjk(text, box_width, font_size=font_size, pad_x=pad_x)
    line_px = font_size * line_height_ratio
    calc_h = max(min_height, len(lines) * line_px + pad_y)
    return lines, round(calc_h, 1)


# ---------------------------------------------------------------------------
# 4. Feishu Whiteboard Node Constructors
# ---------------------------------------------------------------------------
def make_section_node(
    sec_id: str,
    x: float,
    y: float,
    width: float,
    height: float,
    title: str,
) -> Dict[str, Any]:
    """Construct a Feishu Board `section` (container group) node."""
    return {
        "id": sec_id,
        "type": "section",
        "x": round(x, 1),
        "y": round(y, 1),
        "width": round(width, 1),
        "height": round(height, 1),
        "text": {"content": title, "font_size": 14, "text_weight": "bold"},
    }


def make_shape_node(
    node_id: str,
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
    shape_type: str = "round_rect",
    fill_color: str = "#262934",
    border_color: str = "#475569",
    text_color: str = "#1F2329",
    font_size: int = 12,
    bold: bool = False,
    align: str = "center",
    wrapped_lines: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Construct a Feishu Board `composite_shape` node payload."""
    if wrapped_lines is None:
        wrapped_lines = wrap_text_cjk(text, width, font_size=font_size)
    return {
        "id": node_id,
        "type": "composite_shape",
        "x": round(x, 1),
        "y": round(y, 1),
        "width": round(width, 1),
        "height": round(height, 1),
        "composite_shape": {"type": shape_type},
        "text": {
            "content": "\n".join(wrapped_lines),
            "font_size": font_size,
            "text_weight": "bold" if bold else "regular",
            "text_color": text_color,
            "horizontal_align": align,
            "vertical_align": "middle",
            "_wrapped_lines": wrapped_lines,
        },
        "style": {
            "fill_color": fill_color,
            "fill_opacity": 100,
            "border_color": border_color,
            "border_width": 0,
            "border_style": "solid",
        },
    }


def make_connector_node(
    conn_id: str,
    start_id: str,
    end_id: str,
    start_pos: Tuple[float, float],
    end_pos: Tuple[float, float],
    color: str = "#64748B",
    label: str = "",
    curved: bool = False,
) -> Dict[str, Any]:
    """Construct a Feishu Board `connector` node linking two shapes."""
    node: Dict[str, Any] = {
        "id": conn_id,
        "type": "connector",
        "start_object": {"id": start_id, "position": {"x": round(start_pos[0], 1), "y": round(start_pos[1], 1)}},
        "end_object": {"id": end_id, "position": {"x": round(end_pos[0], 1), "y": round(end_pos[1], 1)}},
        "routing_type": "curved" if curved else "orthogonal",
        "style": {
            "border_color": color,
            "border_width": 2,
            "end_arrow": "triangle",
        },
    }
    if label:
        node["text"] = {"content": label, "font_size": 11, "text_color": "#94A3B8"}
    return node


def strip_internal_keys(nodes):
    """Convert measured internal nodes to the official Board v1 write schema."""
    clean = json.loads(json.dumps(nodes))
    by_id = {n['id']:n for n in clean if n.get('type') == 'composite_shape'}
    for node in clean:
        style = node.setdefault('style', {})
        border_width = style.get('border_width', 'extra_narrow')
        if isinstance(border_width, (int, float)):
            style['border_style'] = 'none' if border_width == 0 else 'solid'
            style['border_width'] = 'extra_narrow' if border_width <= 1 else 'narrow'
        text = node.get('text', {})
        text.pop('_wrapped_lines', None)
        if 'content' in text: text['text'] = text.pop('content')
        if 'text_weight' in text: text['font_weight'] = text.pop('text_weight')
        if text.get('vertical_align') == 'middle': text['vertical_align'] = 'mid'
        if node.get('type') == 'connector' and 'start_object' in node:
            connector = {'shape':'right_angled_polyline'}
            for source, target in (('start_object','start'), ('end_object','end')):
                ref = node.pop(source)
                shape = by_id[ref['id']]
                px = (ref['position']['x']-shape['x'])/shape['width']
                py = (ref['position']['y']-shape['y'])/shape['height']
                direction = 'bottom' if py >= .99 else 'top' if py <= .01 else 'right' if px >= .99 else 'left'
                connector[target] = {'attached_object':{'id':ref['id'], 'snap_to':direction,
                    'position':{'x':round(max(0,min(1,px)),4), 'y':round(max(0,min(1,py)),4)}},
                    'arrow_style':'none' if target == 'start' else 'triangle_arrow'}
            node.pop('routing_type', None)
            style.pop('end_arrow', None)
            if text:
                connector['captions'] = [{'text':text.get('text','')}]
                node.pop('text', None)
            node['connector'] = connector
    return clean



# ---------------------------------------------------------------------------
# 5. Per-Card Dynamic 2D Coordinate Auto-Layout Engine (Zero-Truncation)
# ---------------------------------------------------------------------------
# Native board layout: content determines height; all coordinates use one rail.
BOARD_WIDTH = 1040.0
BOARD_STYLE = {
    'canvas': '#F2F4F5', 'surface': '#FCFDFD', 'soft': '#E8EDEE',
    # Native text colors are restricted to Feishu's theme palette.
    'ink': '#1F2329', 'muted': '#1F2329', 'accent': '#5178C6',
    'good': '#1F2329', 'warn': '#1F2329', 'bad': '#1F2329',
}


def _semantic_ink(value: Any) -> str:
    text = str(value).lower()
    if any(x in text for x in ('🔴', '阻塞', 'high', 'p0')):
        return BOARD_STYLE['bad']
    if any(x in text for x in ('🟡', '关注', 'med', 'p1')):
        return BOARD_STYLE['warn']
    if any(x in text for x in ('🟢', '正常', 'done', '已完成')):
        return BOARD_STYLE['good']
    return BOARD_STYLE['ink']


def _semantic_fill(value):
    text = str(value).lower()
    if any(v in text for v in ('🔴', '阻塞', 'high', 'p0')): return '#F9E8E8'
    if any(v in text for v in ('🟡', '关注', 'med', 'p1')): return '#F5EEDB'
    if any(v in text for v in ('🟢', '正常', 'done', '已完成')): return '#E9F2EC'
    return BOARD_STYLE['surface']


def layout_card_to_board_nodes(card, origin_x=0.0, origin_y=0.0, id_prefix='card'):
    """Lay out all twelve DSL cards on the same editable native board rail."""
    card = normalize_card_schema(card)
    kind = card.get('type', 'table')
    nodes = []
    x, y, width = origin_x + 24, origin_y + 24, BOARD_WIDTH - 48
    body_top = y

    def box(key, text, bx, by, bw, *, size=16, fill=None, ink=None,
            bold=False, minimum=48, align='left'):
        text = str(text)
        lines, height = measure_box_height(text, bw, font_size=size,
                                          min_height=minimum, pad_x=32, pad_y=24)
        node = make_shape_node(f'{id_prefix}_{key}', bx, by, bw, height, text,
                              fill_color=fill or BOARD_STYLE['surface'],
                              border_color=fill or BOARD_STYLE['surface'],
                              text_color=ink if size >= 18 and ink else BOARD_STYLE['ink'],
                              font_size=size, bold=bold, align=align,
                              wrapped_lines=lines)
        nodes.append(node)
        return node

    def link(key, start, end, vertical=False):
        if vertical:
            a = (start['x'] + start['width']/2, start['y'] + start['height'])
            b = (end['x'] + end['width']/2, end['y'])
        else:
            a = (start['x'] + start['width'], start['y'] + start['height']/2)
            b = (end['x'], end['y'] + end['height']/2)
        nodes.append(make_connector_node(f'{id_prefix}_{key}', start['id'], end['id'],
                                        a, b, color=BOARD_STYLE['muted']))

    if card.get('title'):
        title = box('title', card['title'], x, y, width, size=22, bold=True)
        y += title['height'] + 24

    if kind in ('flow', 'timeline'):
        entries = card.get('steps' if kind == 'flow' else 'events', [])
        # Two columns keep CJK descriptions readable; extra stages continue below.
        column_width = (width - 48) / 2
        prev = None
        for offset in range(0, len(entries), 2):
            row = []
            for col, entry in enumerate(entries[offset:offset+2]):
                title = entry.get('t') or entry.get('title', '')
                desc = entry.get('d') or entry.get('desc', '')
                state = entry.get('s', entry.get('status', 'pending'))
                status = {'done':'已完成', 'active':'进行中', 'todo':'待办',
                          'pending':'待推进'}.get(state, state)
                meta = [entry.get('time', ''), entry.get('owner', ''), entry.get('meta', '')]
                if status not in ' '.join(meta): meta.append(status)
                text = '\n'.join(filter(None, [' · '.join(filter(None, meta)), title, desc]))
                node = box(f'stage{offset+col}', text, x + col*(column_width+48), y,
                           column_width, fill=BOARD_STYLE['soft'] if state == 'active' else None,
                           ink=BOARD_STYLE['accent'] if state == 'active' else None)
                row.append(node)
                if prev:
                    link(f'stage_link{offset+col}', prev, node, vertical=(col == 0))
                prev = node
            height = max((n['height'] for n in row), default=48)
            for n in row: n['height'] = height
            # Recompute connector centers after equalizing heights below.
            y += height + 48

    elif kind == 'branch':
        root = box('root', card.get('root', ''), x, y, width, bold=True,
                   fill=BOARD_STYLE['soft'])
        y += root['height'] + 32
        hub = box('hub', card.get('hub', ''), x, y, width, bold=True,
                  ink=BOARD_STYLE['accent'])
        link('root_hub', root, hub, vertical=True)
        y += hub['height'] + 40
        for branch_index, branch in enumerate(card.get('branches', [])):
            previous = hub
            for index, entry in enumerate(branch):
                text = entry.get('t') or entry.get('title', '')
                desc = entry.get('d') or entry.get('desc', '')
                state = entry.get('s', entry.get('status', 'pending'))
                text = '\n'.join(filter(None, [text, desc, {'active':'进行中', 'done':'已完成', 'pending':'待推进'}.get(state, state)]))
                node = box(f'branch{branch_index}_{index}', text, x+56, y, width-56,
                           ink=BOARD_STYLE['accent'] if state == 'active' else None)
                link(f'branch_link{branch_index}_{index}', previous, node, vertical=True)
                previous = node
                y += node['height'] + 24
            y += 16

    elif kind == 'kpi':
        for index, metric in enumerate(card.get('metrics', [])):
            label = box(f'metric{index}_label', metric.get('label', ''), x, y, width,
                        size=16, ink=BOARD_STYLE['muted'])
            y += label['height'] + 8
            cw = (width-48)/2
            baseline = box(f'metric{index}_baseline', f"{metric.get('fromLabel', '基线')}\n{metric.get('from', '')}",
                           x, y, cw, size=22, ink=BOARD_STYLE['muted'])
            current = box(f'metric{index}_current', metric.get('to', ''), x+cw+48, y, cw,
                          size=32, ink=BOARD_STYLE['accent'], bold=True)
            y += max(baseline['height'], current['height']) + 8
            delta = box(f'metric{index}_delta', ' · '.join(filter(None, [metric.get('toLabel', '当前值'), metric.get('delta', '')])),
                        x+cw+48, y, cw, size=16, ink=BOARD_STYLE['muted'])
            y += delta['height'] + 32

    elif kind in ('grid', 'pros-cons'):
        entries = card.get('items', []) if kind == 'grid' else [card.get('left', {}), card.get('right', {})]
        columns = min(3, max(1, int(card.get('cols', 2)))) if kind == 'grid' else 2
        cw = (width - 24*(columns-1))/columns
        for offset in range(0, len(entries), columns):
            row = []
            for col, entry in enumerate(entries[offset:offset+columns]):
                text = '\n'.join(filter(None, [entry.get('t') or entry.get('title', ''),
                        entry.get('tag', ''), entry.get('d') or entry.get('desc', ''),
                        '\n'.join('• '+str(v) for v in entry.get('items', []))]))
                row.append(box(f'panel{offset+col}', text, x+col*(cw+24), y, cw,
                               fill=BOARD_STYLE['soft']))
            y += max((n['height'] for n in row), default=48) + 24
        if card.get('verdict'):
            verdict = box('verdict', card['verdict'], x, y, width, bold=True,
                          ink=BOARD_STYLE['accent'])
            y += verdict['height'] + 24

    elif kind == 'quote-decision':
        text = '\n'.join(filter(None, [card.get('speaker', ''), card.get('role', ''),
                                     card.get('text', ''), card.get('impact', '')]))
        quote = box('quote', text, x, y, width, size=22, fill=BOARD_STYLE['soft'])
        y += quote['height'] + 24

    elif kind == 'funnel-metric':
        for index, entry in enumerate(card.get('bars', [])):
            label = ' · '.join(str(v) for v in (entry.get('label', ''), entry.get('val', ''), entry.get('note', '')) if v != '')
            node = box(f'funnel{index}_label', label, x, y, width)
            y += node['height'] + 8
            pct = float(entry.get('pct', 0))
            if not 0 <= pct <= 100:
                raise ValueError('funnel pct must be between 0 and 100')
            box(f'funnel{index}_track', '', x, y, width, fill=BOARD_STYLE['soft'], minimum=16)['height'] = 16
            if pct > 0:
                box(f'funnel{index}_bar', '', x, y, width*pct/100,
                    fill=BOARD_STYLE['accent'], minimum=16)['height'] = 16
            y += 16 + 24

    else:
        headers, rows = card.get('headers', []), card.get('rows', [])
        if kind == 'action-list':
            headers = ['状态', '优先级', '待办事项', '责任人', '截止时间']
            rows = [[{'done':'已完成', 'active':'进行中', 'todo':'待办', 'pending':'待推进'}.get(a.get('s', 'todo'), a.get('s')),
                     a.get('p', ''), a.get('t', a.get('title', '')), a.get('owner', ''), a.get('due', '')]
                    for a in card.get('actions', [])]
        elif kind == 'risk-matrix':
            headers = ['等级', '风险事项', '缓解措施', '责任人']
            rows = [[r.get('level', 'med').upper(), r.get('risk', ''), r.get('mitigation', ''), r.get('owner', '')]
                    for r in card.get('risks', [])]
        count = max(len(headers), max((len(r) for r in rows), default=0), 1)
        weights = [max(6, min(32, max([len(str(r[c])) for r in rows if c < len(r)] + [len(str(headers[c])) if c < len(headers) else 6]))) for c in range(count)]
        available = width - 8*(count-1)
        widths = [available*w/sum(weights) for w in weights]
        spans = [1]*len(rows)
        if kind == 'status-table':
            index = 0
            while index < len(rows):
                end = index+1
                while end < len(rows) and rows[index] and rows[end] and rows[index][0] == rows[end][0]:
                    spans[index] += 1; spans[end] = 0; end += 1
                index = end
        heights = []
        for row in [headers]+rows:
            heights.append(max([measure_box_height(str(row[c]) if c < len(row) else '', widths[c], font_size=16, pad_x=32, pad_y=24)[1] for c in range(count)] + [48]))
        if not headers: heights[0] = 0
        for ri, row in enumerate([headers]+rows):
            if ri == 0 and not headers: continue
            cx = x
            for ci in range(count):
                raw = str(row[ci]) if ci < len(row) else ''
                if ri > 0 and ci == 0 and kind == 'status-table' and spans[ri-1] == 0:
                    cx += widths[ci]+8; continue
                height = heights[ri]
                if ri > 0 and ci == 0 and kind == 'status-table':
                    height = sum(heights[ri:ri+spans[ri-1]]) + 8*(spans[ri-1]-1)
                numeric = bool(raw.strip()) and all(ch.isdigit() or ch in '.,%+-¥$ ' for ch in raw)
                node = box(f'cell{ri}_{ci}', raw, cx, y, widths[ci],
                           fill=BOARD_STYLE['soft'] if ri == 0 else _semantic_fill(raw),
                           ink=BOARD_STYLE['muted'] if ri == 0 else _semantic_ink(raw),
                           bold=ri == 0, align='right' if numeric and ri else 'left')
                node['height'] = height
                cx += widths[ci]+8
            y += heights[ri]+8
        y += 16

    if y == body_top:
        empty = box('empty', '暂无记录', x, y, width, ink=BOARD_STYLE['muted'])
        y += empty['height']+24
    height = max(96, y-origin_y)
    background = make_shape_node(f'{id_prefix}_background', origin_x, origin_y,
                                BOARD_WIDTH, height, '', fill_color=BOARD_STYLE['surface'],
                                border_color=BOARD_STYLE['surface'], wrapped_lines=[])
    nodes.insert(0, background)
    # All connector endpoints must use final measured geometry.
    by_id = {n['id']: n for n in nodes if n['type'] == 'composite_shape'}
    for node in nodes:
        if node['type'] != 'connector': continue
        for end in ('start_object', 'end_object'):
            ref = node[end]; target = by_id[ref['id']]
            if abs(ref['position']['x'] - (target['x']+target['width']/2)) < 1:
                ref['position']['y'] = target['y'] + (target['height'] if end == 'start_object' else 0)
            else:
                ref['position']['y'] = target['y']+target['height']/2
    mermaid = ['flowchart TB']
    for node in nodes:
        if node['type'] == 'composite_shape' and node.get('text', {}).get('content'):
            text = node['text']['content'].replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;').replace('\n', '<br/>')
            mermaid.append(f'  {node["id"]}["{text}"]')
        elif node['type'] == 'connector':
            mermaid.append(f'  {node["start_object"]["id"]} --> {node["end_object"]["id"]}')
    return nodes, BOARD_WIDTH, round(height, 1), '\n'.join(mermaid)


def compile_full_meeting_whiteboard(data):
    all_nodes, per_card = [], []
    x, y = 48, 40
    width = BOARD_WIDTH

    def heading(key, text, size, ink, fill):
        nonlocal y
        lines, height = measure_box_height(str(text), width, font_size=size,
                                          min_height=48, pad_x=32, pad_y=24)
        all_nodes.append(make_shape_node(key, x, y, width, height, str(text),
                         font_size=size, bold=size >= 22, align='left', text_color=ink,
                         fill_color=fill, border_color=fill, wrapped_lines=lines))
        y += height + 16

    heading('wb_title', data.get('title', data.get('t', '会议纪要')), 32, BOARD_STYLE['ink'], BOARD_STYLE['canvas'])
    if data.get('subtitle', data.get('sub')):
        heading('wb_subtitle', data.get('subtitle', data.get('sub')), 16, BOARD_STYLE['muted'], BOARD_STYLE['canvas'])
    if data.get('summary'):
        heading('wb_summary', data['summary'], 20, BOARD_STYLE['ink'], BOARD_STYLE['soft'])
    for si, section in enumerate(data.get('sections', data.get('sec', []))):
        y += 32
        heading(f'sec{si}_title', section.get('title', section.get('t', '议题')), 24, BOARD_STYLE['ink'], BOARD_STYLE['canvas'])
        for ii, item in enumerate(section.get('items', section.get('b', []))):
            if isinstance(item, str) or isinstance(item, dict) and 'type' not in item:
                text = item if isinstance(item, str) else item.get('text', item.get('t', ''))
                heading(f'sec{si}_note{ii}', text, 16, BOARD_STYLE['ink'], BOARD_STYLE['surface'])
            elif isinstance(item, dict):
                key = f's{si}_c{ii}'
                nodes, w, h, mermaid = layout_card_to_board_nodes(item, x, y, key)
                all_nodes.extend(nodes)
                local_nodes, lw, lh, lm = layout_card_to_board_nodes(item, 16, 16, key)
                per_card.append({'card_id': key, 'title': item.get('title', item.get('type', '')),
                    'type': item.get('type'), 'canvas': {'width': lw+32, 'height': lh+32},
                    'feishu_openapi_payload': {'nodes': strip_internal_keys(local_nodes)},
                    'feishu_plantuml_payload': {'syntax_type':'mermaid', 'style_type':1, 'content':lm}})
                y += h+24
    canvas = {'width': width+96, 'height': round(y+40, 1)}
    all_nodes.insert(0, make_shape_node('wb_canvas', 0, 0, canvas['width'], canvas['height'], '',
                     fill_color=BOARD_STYLE['canvas'], border_color=BOARD_STYLE['canvas'], wrapped_lines=[]))
    clean = strip_internal_keys(all_nodes)
    return {'meta': {'title': data.get('title', data.get('t', '会议纪要')),
                     'total_nodes': len(all_nodes), 'total_embedded_boards': len(per_card),
                     'layout': 'decision-ledger-v3', 'canvas': canvas, 'canvas_width': canvas['width'], 'canvas_height': canvas['height']},
            'full_whiteboard_payload': {'nodes': all_nodes},
            'feishu_openapi_clean_payload': {'nodes':clean}, 'embedded_card_boards':per_card}


class FeishuBoardClient:
    """Self-built bot application identity only; never accepts a user token."""
    def __init__(self, app_id='', app_secret='', base_url='https://open.feishu.cn', qps_limit=4.5):
        if base_url != 'https://open.feishu.cn':
            raise ValueError('Only the official Feishu API origin is supported')
        self.app_id = (app_id or os.environ.get('FEISHU_APP_ID', '')).strip()
        self.app_secret = app_secret or os.environ.get('FEISHU_APP_SECRET', '')
        if not self.app_id or not self.app_secret.strip():
            raise ValueError('机器人导出需要 App ID 和 App Secret：配置 FEISHU_APP_ID / FEISHU_APP_SECRET，或使用 --app-id / --app-secret-env。不要提供用户 access token。')
        self.access_token = ''
        self._token_deadline = 0.0
        self.base_url = base_url
        self.min_interval = 1.0 / max(0.5, qps_limit)
        self._last_req_ts = 0.0

    def _throttle(self):
        delay = self.min_interval - (time.monotonic()-self._last_req_ts)
        if delay > 0: time.sleep(delay)
        self._last_req_ts = time.monotonic()

    def _safe_message(self, value):
        text = str(value)
        for secret in (self.app_secret, self.access_token):
            if secret: text = text.replace(secret, '[REDACTED]')
        return text[:400]

    def _send(self, method, path, body=None, authorized=True, max_retries=4):
        url = self.base_url+path
        payload = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
        for attempt in range(max_retries+1):
            if authorized and time.monotonic() >= self._token_deadline:
                self.authenticate()
            headers = {'Content-Type':'application/json; charset=utf-8'}
            if authorized: headers['Authorization'] = 'Bearer '+self.access_token
            self._throttle()
            request = urllib.request.Request(url, data=payload, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    result = json.loads(response.read().decode('utf-8'))
            except urllib.error.HTTPError as error:
                status = error.code
                retry_after = error.headers.get('Retry-After', '') if error.headers else ''
                error.close()
                if status == 429 and attempt < max_retries:
                    delay = float(retry_after) if retry_after.replace('.', '', 1).isdigit() else 1.2*2**attempt
                    time.sleep(min(15, delay)); continue
                # A timed-out or failed POST may already have taken effect: do not replay it.
                raise RuntimeError(f'Feishu API HTTP {status}; 检查应用权限、资源共享和部分写入结果后再重试。') from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise RuntimeError('Feishu API 网络请求失败；写入结果可能不完整，请检查目标后再重试。') from None
            except (ValueError, UnicodeError):
                raise RuntimeError('Feishu API 返回无效 JSON') from None
            if not isinstance(result, dict):
                raise RuntimeError('Feishu API 返回格式无效')
            code = result.get('code')
            if code != 0:
                raise RuntimeError(f'Feishu API code={code}: {self._safe_message(result.get("msg", "missing success code"))}')
            return result
        raise RuntimeError('Feishu API 限流重试次数已用尽')

    def authenticate(self):
        result = self._send('POST', '/open-apis/auth/v3/tenant_access_token/internal',
                            {'app_id':self.app_id, 'app_secret':self.app_secret}, authorized=False)
        token, expire = result.get('tenant_access_token'), result.get('expire')
        if not isinstance(token, str) or not token or not isinstance(expire, (int, float)) or expire <= 0:
            raise RuntimeError('飞书鉴权响应缺少有效 tenant_access_token / expire')
        self.access_token = token
        self._token_deadline = time.monotonic()+max(1, expire-min(60, expire/2))
        return token

    def _request(self, method, path, body=None, max_retries=4):
        if not path.startswith('/open-apis/'):
            raise ValueError('Invalid Feishu API path')
        return self._send(method, path, body, max_retries=max_retries)

    def draw_nodes_on_board(self, whiteboard_id, nodes):
        # Client node IDs only identify references within this single create request.
        if not 1 <= len(nodes) <= 3000:
            raise ValueError('A board export requires 1..3000 nodes; split the meeting before export')
        return [self._request('POST', f'/open-apis/board/v1/whiteboards/{whiteboard_id}/nodes',
                             {'nodes':strip_internal_keys(nodes)})]

    def draw_mermaid_on_board(self, whiteboard_id, mermaid_text, style_type=1):
        return self._request('POST', f'/open-apis/board/v1/whiteboards/{whiteboard_id}/nodes/plantuml',
                             {'syntax_type':'mermaid', 'style_type':style_type, 'content':mermaid_text})

    def create_docx_with_embedded_boards(
        self,
        data: Dict[str, Any],
        document_id: str = "",
        folder_token: str = "",
        draw_mode: str = "nodes",
    ) -> Dict[str, Any]:
        """
        Batch-optimized Feishu Docx + Embedded Whiteboard Direct Drawing Pipeline.
        Batches top-level section blocks (`children` array up to 50 blocks per request)
        to minimize API calls and avoid HTTP 429 rate limits.
        """
        if draw_mode == 'nodes':
            for section in data.get('sections', data.get('sec', [])):
                for item in section.get('items', section.get('b', [])):
                    if isinstance(item, dict) and 'type' in item:
                        count = len(layout_card_to_board_nodes(item)[0])
                        if count > 3000:
                            raise ValueError('Embedded board exceeds 3000 nodes; split this card before export')
        title = data.get("title") or data.get("t", "智能会议纪要")
        if not document_id:
            payload: Dict[str, Any] = {"title": title}
            if folder_token:
                payload["folder_token"] = folder_token
            doc_res = self._request("POST", "/open-apis/docx/v1/documents", payload)
            document_id = doc_res["data"]["document"]["document_id"]

        print(f'[INFO] Bot export target document: {document_id}', file=sys.stderr)
        intro = [data.get('subtitle', data.get('sub', '')), data.get('summary', data.get('sum', ''))]
        blocks = [{'block_type':2, 'text':{'elements':[{'text_run':{'content':str(text)}}]}} for text in intro if text]
        if blocks:
            self._request('POST', f'/open-apis/docx/v1/documents/{document_id}/blocks/{document_id}/children', {'children':blocks})
        drawn_boards: List[Dict[str, Any]] = []
        sections = data.get("sections") or data.get("sec", [])

        for s_idx, sec in enumerate(sections):
            stitle = sec.get("title") or sec.get("t", f"议题 {s_idx + 1}")
            scolor = sec.get("color") or sec.get("c", "blue")
            pal = BOARD_PALETTE.get(scolor, BOARD_PALETTE["blue"])
            items = sec.get("items") or sec.get("b", [])

            # Batch create all top-level blocks for this section in ONE request!
            sec_children_payload: List[Dict[str, Any]] = [
                {"block_type": 4, "heading2": {"elements": [{"text_run": {"content": stitle}}]}}
            ]
            item_meta: List[Tuple[str, Any, int]] = []  # (kind, data, index_in_children)

            for i_idx, item in enumerate(items):
                if isinstance(item, str) or (isinstance(item, dict) and "type" not in item):
                    txt = item if isinstance(item, str) else (item.get("text") or item.get("t", ""))
                    item_meta.append(("callout", txt, len(sec_children_payload)))
                    sec_children_payload.append(
                        {
                            "block_type": 19,
                            "callout": {
                                "background_color": pal["docx_bg"],
                                "border_color": pal["docx_border"],
                            },
                        }
                    )
                elif isinstance(item, dict):
                    item_meta.append(("board", (i_idx, item), len(sec_children_payload)))
                    sec_children_payload.append({"block_type": 43, "board": {}})

            created_blocks = []
            for offset in range(0, len(sec_children_payload), 50):
                batch = sec_children_payload[offset:offset+50]
                result = self._request('POST', f'/open-apis/docx/v1/documents/{document_id}/blocks/{document_id}/children', {'children':batch})
                children = result.get('data', {}).get('children', [])
                if len(children) != len(batch):
                    raise RuntimeError(f'Incomplete document blocks in {document_id}; inspect partial output')
                created_blocks.extend(children)
            for kind, meta_val, child_idx in item_meta:
                blk = created_blocks[child_idx]
                if kind == "callout":
                    callout_id = blk["block_id"]
                    self._request(
                        "POST",
                        f"/open-apis/docx/v1/documents/{document_id}/blocks/{callout_id}/children",
                        {"children": [{"block_type": 2, "text": {"elements": [{"text_run": {"content": f"- {meta_val}"}}]}}]},
                    )
                elif kind == "board":
                    i_idx, card_obj = meta_val
                    wb_id = blk.get("board", {}).get("token", "")
                    if not wb_id:
                        raise RuntimeError(f"Missing board token in {document_id}; inspect partial output")
                    if wb_id:
                        prefix = f"s{s_idx}_c{i_idx}"
                        local_nodes, _, _, m_code = layout_card_to_board_nodes(
                            card_obj, origin_x=16.0, origin_y=14.0, id_prefix=prefix
                        )
                        if draw_mode == "mermaid":
                            self.draw_mermaid_on_board(wb_id, m_code)
                        else:
                            self.draw_nodes_on_board(wb_id, local_nodes)
                        drawn_boards.append({"card_id": prefix, "whiteboard_id": wb_id, "nodes_count": len(local_nodes)})

        return {"document_id": document_id, "embedded_boards_drawn": drawn_boards}



def main():
    parser = argparse.ArgumentParser(description='Meeting minutes: native board layout and bot-owned Feishu export')
    parser.add_argument('input', help='Meeting JSON DSL')
    parser.add_argument('-o', '--output', '--export', default='feishu_board_payload.json')
    target = parser.add_mutually_exclusive_group()
    target.add_argument('--board-id', help='Append to an existing board shared with the bot')
    target.add_argument('--doc-id', help='Append sections to an existing document shared with the bot')
    target.add_argument('--create-docx', action='store_true', help='Create a document as the bot application')
    parser.add_argument('--folder-token', help='Destination folder, only for --create-docx')
    parser.add_argument('--mode', choices=('nodes', 'mermaid'), default='nodes', help='nodes preserves the designed layout; mermaid uses Feishu layout')
    parser.add_argument('--app-id', help='Self-built bot application App ID; defaults to FEISHU_APP_ID')
    parser.add_argument('--app-secret-env', default='FEISHU_APP_SECRET', help='Environment variable containing App Secret (value is never printed)')
    parser.add_argument('--app-secret-file', help='UTF-8 App Secret file, preferably outside the skill/output directory')
    parser.add_argument('--token', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.folder_token and not args.create_docx:
        parser.error('--folder-token 仅适用于 --create-docx')
    if args.token:
        parser.error('--token 已停用：导出必须使用机器人应用的 App ID / App Secret')
    remote = bool(args.board_id or args.doc_id or args.create_docx)
    try:
        client = None
        if remote:
            secret = pathlib.Path(args.app_secret_file).read_text(encoding='utf-8').strip() if args.app_secret_file else os.environ.get(args.app_secret_env, '')
            if not secret:
                raise ValueError(f'缺少 App Secret：请设置 {args.app_secret_env}，或使用 --app-secret-file 指向密钥文件')
            client = FeishuBoardClient(app_id=args.app_id or '', app_secret=secret)
        data = load_and_repair_json(pathlib.Path(args.input).read_text(encoding='utf-8'))
        compiled = compile_full_meeting_whiteboard(data)
        exported = dict(compiled)
        exported['full_whiteboard_payload'] = exported.pop('feishu_openapi_clean_payload')
        output = pathlib.Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(exported, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[OK] Native board layout: {compiled["meta"]["total_nodes"]} nodes -> {output}')
        if args.board_id:
            if args.mode == 'nodes':
                client.draw_nodes_on_board(args.board_id, compiled['full_whiteboard_payload']['nodes'])
            else:
                for card in compiled['embedded_card_boards']:
                    client.draw_mermaid_on_board(args.board_id, card['feishu_plantuml_payload']['content'])
            print(f'[OK] Bot application export completed: board {args.board_id}')
        elif args.create_docx or args.doc_id:
            result = client.create_docx_with_embedded_boards(data, document_id=args.doc_id,
                        folder_token=args.folder_token, draw_mode=args.mode)
            print(f'[OK] Bot application export completed: document {result["document_id"]}')
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as error:
        # Network/API exceptions are sanitized in the client. Do not dump input or credentials.
        print(f'[ERROR] {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
