#!/usr/bin/env python3
"""bvh_to_soma30 — CMU BVH → SOMA30-named animated GLB (LAW-0015 轉換器)

用法: blender -b -P bvh_to_soma30.py -- <in.bvh> <out.glb> [frame_end]
原理: ①BVH文字層改名（MOTION通道位置對齊，改名唔甩動畫）②Blender骨手術
      （刪非SOMA關節＋加Jaw/雙眼靜態骨＝啱啱30）③匯出GLB。
驗收: skintokens-cli glb-info → rigKind=soma30, jointCount=30, hasAnimation。
"""
import bpy, sys, os

# CMU cgspeed 名 → SOMA30 官方30名（skintokens src/retarget.cpp soma_names）
RENAMES = [
    # 順序敏感：先保護舊名（TMP），防止 substring 雙重替換
    ('JOINT Neck1', 'JOINT __N2'), ('JOINT Neck', 'JOINT Neck1'), ('JOINT __N2', 'JOINT Neck2'),
    ('JOINT LeftLeg', 'JOINT __SL'), ('JOINT LeftUpLeg', 'JOINT LeftLeg'), ('JOINT __SL', 'JOINT LeftShin'),
    ('JOINT RightLeg', 'JOINT __SR'), ('JOINT RightUpLeg', 'JOINT RightLeg'), ('JOINT __SR', 'JOINT RightShin'),
    ('JOINT Spine1', 'JOINT __C'), ('JOINT Spine', 'JOINT Spine2'), ('JOINT LowerBack', 'JOINT Spine1'), ('JOINT __C', 'JOINT Chest'),
    ('JOINT LeftHandIndex1', 'JOINT LeftHandMiddleEnd'), ('JOINT RightHandIndex1', 'JOINT RightHandMiddleEnd'),
    ('JOINT LThumb', 'JOINT LeftHandThumbEnd'), ('JOINT RThumb', 'JOINT RightHandThumbEnd'),
]
SOMA30 = {
    'Hips','Spine1','Spine2','Chest','Neck1','Neck2','Head','Jaw','LeftEye','RightEye',
    'LeftShoulder','LeftArm','LeftForeArm','LeftHand','LeftHandThumbEnd','LeftHandMiddleEnd',
    'RightShoulder','RightArm','RightForeArm','RightHand','RightHandThumbEnd','RightHandMiddleEnd',
    'LeftLeg','LeftShin','LeftFoot','LeftToeBase','RightLeg','RightShin','RightFoot','RightToeBase',
}

def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(argv) < 2:
        sys.stderr.write('usage: blender -b -P bvh_to_soma30.py -- <in.bvh> <out.glb> [frame_end]\n')
        sys.exit(2)
    src_bvh, out_glb = argv[0], argv[1]
    frame_end = int(argv[2]) if len(argv) > 2 else 200

    # ① 文字層改名（寫暫存 BVH，唔掂原件）
    t = open(src_bvh, 'r', encoding='latin1').read()
    for a, b in RENAMES:
        t = t.replace(a, b)
    tmp_bvh = out_glb + '.tmp.bvh'
    open(tmp_bvh, 'w', encoding='latin1').write(t)

    # ② Blender 骨手術
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_anim.bvh(filepath=tmp_bvh, frame_start=1)
    arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    drop = [n for n in eb.keys() if n not in SOMA30]
    if 'Hips' not in eb.keys():
        sys.stderr.write(f'soma30_convert_error: 冇Hips——呢個BVH可能唔係CMU cgspeed命名（搵到:{sorted(eb.keys())[:8]}…）\n')
        sys.exit(3)
    for nm in drop:
        b = eb.get(nm)
        if b:
            for c in list(b.children):
                c.parent = b.parent
            eb.remove(b)
    head = eb.get('Head')
    for nm in ('Jaw', 'LeftEye', 'RightEye'):
        nb = eb.new(nm)
        nb.parent = head
        nb.head = head.tail.copy()
        nb.tail = nb.head
    n = len(eb)
    if n != 30:
        sys.stderr.write(f'soma30_joint_count_mismatch: {n}≠30（drop={drop}）——唔准出貨\n')
        sys.exit(4)
    bpy.ops.object.mode_set(mode='OBJECT')

    # ③ 匯出
    bpy.context.scene.frame_end = frame_end
    bpy.ops.export_scene.gltf(filepath=out_glb, export_format='GLB', export_animations=True)
    os.remove(tmp_bvh)
    print(f'SOMA30_OK {out_glb} joints=30 frames={frame_end}')

main()
