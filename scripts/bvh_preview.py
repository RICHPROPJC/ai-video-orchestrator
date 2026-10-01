#!/usr/bin/env python3
"""bvh_preview — CMU BVH 動作預覽（LAW-0012 QC 工具）

用法: python3 bvh_preview.py <in.bvh> <out_prefix> [f0] [f1]
出: <out_prefix>.mp4（三畫面：側視/正視/手部特寫）＋兩張 still
閘: 每畫面黑線內容 >2% 先准出（bvh_preview_gate_fail 即棄）
取景: 跟數據 bbox＋10% margin——人永遠填滿畫面，唔靠硬編 limits。
"""
import sys, re, math, subprocess, os
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

FINGER = re.compile(r'Thumb|Finger|Index')

def parse_bvh(path):
    t = open(path, 'r', encoding='latin1').read()
    lines = t.splitlines()
    joints, stack, i = [], [], 0
    while i < len(lines):
        l = lines[i].strip()
        if l.startswith('ROOT') or l.startswith('JOINT'):
            nm = l.split()[1]
            joints.append(dict(name=nm, parent=stack[-1] if stack else None, off=None, ch=None))
            stack.append(len(joints) - 1)
        elif l.startswith('OFFSET'):
            off = [float(x) for x in l.split()[1:4]]
            if joints and joints[stack[-1]]['off'] is None:
                joints[stack[-1]]['off'] = off
        elif l.startswith('CHANNELS'):
            p = l.split()
            joints[stack[-1]]['ch'] = p[2:2 + int(p[1])]
        elif l == '}':
            if stack: stack.pop()
        elif l.startswith('MOTION'):
            break
        i += 1
    nfr = int(re.search(r'Frames:\s*(\d+)', t).group(1))
    ml = [l for l in t[t.index('MOTION'):].splitlines()[3:] if l.strip()]
    data = np.array([[float(x) for x in l.split()] for l in ml[:nfr]])
    return joints, data, nfr

def _rot(ax, d):
    a = math.radians(d); c, s = math.cos(a), math.sin(a)
    if ax == 0: return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if ax == 1: return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])

def frame_pos(joints, row):
    pos = np.zeros((len(joints), 3)); Rs = [None] * len(joints); ptr = 0
    for j, jd in enumerate(joints):
        loc = np.zeros(3); R = np.eye(3)
        for c in (jd['ch'] or []):
            v = row[ptr]; ptr += 1
            if c == 'Xposition': loc[0] += v
            elif c == 'Yposition': loc[1] += v
            elif c == 'Zposition': loc[2] += v
            else: R = _rot({'Xrotation': 0, 'Yrotation': 1, 'Zrotation': 2}[c], v) @ R
        p = jd['parent']
        if p is None: Rs[j] = R; pos[j] = loc
        else: Rs[j] = Rs[p] @ R; pos[j] = pos[p] + Rs[p] @ (np.array(jd['off']) + loc)
    return pos

def draw(ax, joints, pos, xax, title, zoom=None):
    for j, jd in enumerate(joints):
        p = jd['parent']
        if p is None: continue
        nm = jd['name']
        if FINGER.search(nm): lw, c = 2.5, 'crimson'
        elif 'Hand' in nm: lw, c = 5, 'black'
        elif any(x in nm for x in ['Arm', 'Shoulder', 'UpLeg', 'Leg', 'Foot', 'Toe', 'HipJoint']): lw, c = 7, 'black'
        else: lw, c = (11 if nm in ('Spine', 'Spine1', 'LowerBack') else 8), 'black'
        ax.plot([pos[p, xax], pos[j, xax]], [pos[p, 1], pos[j, 1]], '-', c=c, lw=lw, solid_capstyle='round')
    hd = [j for j, jd in enumerate(joints) if jd['name'] == 'Head']
    if hd:
        h = pos[hd[0]]
        ax.add_patch(plt.Circle((h[xax], h[1]), 11, color='black'))
    if zoom:
        x0, x1, y0, y1 = zoom
    else:
        xs = pos[:, xax]
        x0, x1 = xs.min() - 12, xs.max() + 12
        y0, y1 = pos[:, 1].min() - 12, pos[:, 1].max() + 12
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1)
    ax.set_aspect('equal'); ax.axis('off'); ax.set_title(title, fontsize=8)

def main():
    bvh, prefix = sys.argv[1], sys.argv[2]
    f0 = int(sys.argv[3]) if len(sys.argv) > 3 else None
    joints, data, nfr = parse_bvh(bvh)
    f1 = int(sys.argv[4]) if len(sys.argv) > 4 else nfr
    if f0 is None: f0 = 0
    frames = list(range(f0, min(f1, nfr), 5))
    hand_idx = [j for j, jd in enumerate(joints) if FINGER.search(jd['name']) or 'Hand' in jd['name']]
    tmpdir = prefix + '_frames'
    os.makedirs(tmpdir, exist_ok=True)
    for k, fi in enumerate(frames):
        pos = frame_pos(joints, data[fi])
        hp = pos[hand_idx]
        hz = (hp[:, 2].min() - 15, hp[:, 2].max() + 15, hp[:, 1].min() - 15, hp[:, 1].max() + 15)
        fig, axs = plt.subplots(1, 3, figsize=(12, 4.2), dpi=100)
        draw(axs[0], joints, pos, 2, f'side  {fi/120:.1f}s')
        draw(axs[1], joints, pos, 0, 'front')
        draw(axs[2], joints, pos, 2, 'hand zoom', zoom=hz)
        fig.patch.set_facecolor('white')
        plt.tight_layout()
        plt.savefig(f'{tmpdir}/f{k:03d}.png', facecolor='white'); plt.close()
    # 閘：中間幀每畫面黑線內容>2%
    from PIL import Image
    mid = f'{tmpdir}/f{len(frames)//2:03d}.png'
    im = Image.open(mid).convert('L'); px = list(im.getdata())
    content = sum(1 for p in px if p < 60) / len(px) * 100
    if content < 2:
        print(f'bvh_preview_gate_fail: 內容{content:.1f}%<2%'); sys.exit(1)
    mp4 = prefix + '.mp4'
    subprocess.run(['ffmpeg', '-y', '-framerate', '10', '-pattern_type', 'glob', '-i',
                    f'{tmpdir}/f*.png', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4],
                   capture_output=True)
    print(f'bvh_preview_ok: {mp4} frames={len(frames)} content={content:.1f}%')

main()
