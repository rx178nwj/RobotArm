"""
RobotArm2 — DH パラメータ確認スクリプト
Rev 0.9 (2026-06-28)

Standard DH 規則:  T_i = Rz(q_i + offset_i) · Tz(d) · Tx(a) · Rx(α)
単位: mm, rad

注意: roboticstoolbox の RevoluteDH では theta は無視される (DHLink.py:757 で 0 に上書き)。
      関節オフセットは必ず offset パラメータで指定すること。

Rev 0.9 変更: J1(旋回) に d=115, alpha=pi/2 を移し、J2(肩ピッチ) を d=0, alpha=0 に変更。
  理由: 旧設定(Rev 0.8)では z1=世界Z となり J2 が J1 と同じ旋回方向に回転する不具合。
  修正後: z1=世界-Y (水平) → J2 が正しく肩ピッチになる。
"""

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import roboticstoolbox as rtb
from math import pi
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from spatialmath import SE3

robot = rtb.DHRobot(
    [
        rtb.RevoluteDH(d=115, a=0,   alpha=pi/2,  offset=pi/2,  qlim=[-pi, pi]),  # J1 旋回
        rtb.RevoluteDH(d=0,   a=160, alpha=pi,    offset=0,     qlim=[-pi, pi]),  # J2 肩ピッチ
        rtb.RevoluteDH(d=0,   a=160, alpha=pi,    offset=0,     qlim=[-pi, pi]),  # J3 肘
        rtb.RevoluteDH(d=0,   a=0,   alpha=-pi/2, offset=-pi/2, qlim=[-pi, pi]),  # J4 前腕
        rtb.RevoluteDH(d=160,  a=0,   alpha=-pi/2,  offset=-pi,  qlim=[-pi, pi]),  # J5 手首ピッチ
        rtb.RevoluteDH(d=0,   a=100,   alpha=0,     offset=0,     qlim=[-pi, pi]),  # J6 手首ロール
    ],
    name="RobotArm2_6DOF",
)

# 初期位置: 全軸 0deg
# q_home は teach() 起動時の初期姿勢として使う
q_home = [0, 0, 0, 0, 0, 0]

# ワーク箱: 中心座標 [mm] とサイズ [mm]
work_center = np.array([150.0, 250.0, 50.0])
work_size = np.array([120.0, 80.0, 100.0])

# 把持目標点: ワーク上面中心の少し上
grasp_clearance = 20.0
grasp_target = work_center + np.array([0.0, 0.0, work_size[2] / 2.0 + grasp_clearance])

# 把持目標姿勢: ツール z 軸をワークへ向け、x 軸は world +X に合わせる
grasp_z_axis = np.array([0.0, 0.0, -1.0])
grasp_x_axis = np.array([1.0, 0.0, 0.0])
grasp_y_axis = np.cross(grasp_z_axis, grasp_x_axis)
grasp_rotation = np.column_stack((grasp_x_axis, grasp_y_axis, grasp_z_axis))
grasp_pose = SE3.Rt(grasp_rotation, grasp_target)


def make_box_faces(center, size):
    hx, hy, hz = size / 2.0
    cx, cy, cz = center
    vertices = np.array([
        [cx - hx, cy - hy, cz - hz],
        [cx + hx, cy - hy, cz - hz],
        [cx + hx, cy + hy, cz - hz],
        [cx - hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz],
        [cx + hx, cy - hy, cz + hz],
        [cx + hx, cy + hy, cz + hz],
        [cx - hx, cy + hy, cz + hz],
    ])
    return [
        [vertices[i] for i in [0, 1, 2, 3]],
        [vertices[i] for i in [4, 5, 6, 7]],
        [vertices[i] for i in [0, 1, 5, 4]],
        [vertices[i] for i in [1, 2, 6, 5]],
        [vertices[i] for i in [2, 3, 7, 6]],
        [vertices[i] for i in [3, 0, 4, 7]],
    ]


def set_axes_equal(ax, points, padding=40.0):
    mins = points.min(axis=0) - padding
    maxs = points.max(axis=0) + padding
    center = (mins + maxs) / 2.0
    radius = np.max(maxs - mins) / 2.0
    ax.set_xlim(center[0] - radius, center[0] + radius)
    ax.set_ylim(center[1] - radius, center[1] + radius)
    ax.set_zlim(center[2] - radius, center[2] + radius)


def draw_frame(ax, pose, axis_length, label, colors):
    origin = pose.t
    rotation = pose.R
    axis_labels = ["x", "y", "z"]
    for i, color in enumerate(colors):
        axis = rotation[:, i] * axis_length
        ax.quiver(
            origin[0], origin[1], origin[2],
            axis[0], axis[1], axis[2],
            color=color, linewidth=2.0, arrow_length_ratio=0.15,
        )
        tip = origin + axis
        ax.text(tip[0], tip[1], tip[2], f"{label}-{axis_labels[i]}", color=color, fontsize=8)


def solve_ik(robot, target_pose, q_seed):
    return robot.ikine_LM(target_pose, q0=q_seed, ilimit=100, slimit=100)


def show_robot_with_work(robot, q, box_center, box_size, target_point, target_pose):
    Ts = robot.fkine_all(q)
    joint_points = np.array([T.t for T in Ts])
    ee_pose = Ts[-1]
    box_faces = make_box_faces(box_center, box_size)

    ax = plt.figure("RobotArm2 Work View").add_subplot(111, projection="3d")
    ax.plot(joint_points[:, 0], joint_points[:, 1], joint_points[:, 2],
            color="tab:blue", linewidth=3, marker="o", markersize=6, label="Robot links")
    ax.scatter(joint_points[-1, 0], joint_points[-1, 1], joint_points[-1, 2],
               color="tab:red", s=60, label="End effector")

    work_box = Poly3DCollection(
        box_faces,
        facecolors="tab:orange",
        edgecolors="black",
        linewidths=1.0,
        alpha=0.35,
    )
    ax.add_collection3d(work_box)
    ax.scatter(box_center[0], box_center[1], box_center[2], color="tab:orange", s=40, label="Work center")
    ax.scatter(target_point[0], target_point[1], target_point[2],
               color="tab:green", s=70, marker="^", label="Grasp target")
    ax.plot(
        [box_center[0], target_point[0]],
        [box_center[1], target_point[1]],
        [box_center[2] + box_size[2] / 2.0, target_point[2]],
        color="tab:green",
        linestyle="--",
        linewidth=1.5,
    )
    ax.plot(
        [joint_points[-1, 0], target_point[0]],
        [joint_points[-1, 1], target_point[1]],
        [joint_points[-1, 2], target_point[2]],
        color="tab:red",
        linestyle=":",
        linewidth=1.5,
    )
    draw_frame(ax, ee_pose, 50.0, "EE", ["red", "green", "blue"])
    draw_frame(ax, target_pose, 40.0, "Target", ["darkred", "darkgreen", "navy"])

    scene_points = np.vstack([
        joint_points,
        box_center + box_size / 2.0,
        box_center - box_size / 2.0,
        target_point,
    ])
    set_axes_equal(ax, scene_points)
    ax.set_xlabel("X [mm]")
    ax.set_ylabel("Y [mm]")
    ax.set_zlabel("Z [mm]")
    ax.set_title("RobotArm2 with Work Box")
    ax.legend(loc="upper left")
    plt.tight_layout()
    plt.show(block=False)

print(robot)

# 各ジョイントの回転軸を確認（旋回=垂直Z、その他=水平）
# DH規則: 関節iの回転軸 = フレームi-1のz軸。J1(q0)はworld Z=[0,0,1]が固定。
print("\n--- ジョイント動作テスト ---")
print("  q0(旋回): z一定で水平回転のはず")
for deg in [0, 45, 90]:
    q = [deg*pi/180, 0, 0, 0, deg*pi/180, 0]
    T = robot.fkine(q)
    print(f"    q0={deg:3d}deg: x={T.t[0]:+6.1f}  y={T.t[1]:+6.1f}  z={T.t[2]:+5.1f}")
print("  q1(肩ピッチ): 縦方向にEEが移動するはず")
for deg in [0, 45, 90]:
    q = [0, deg*pi/180, 0, 0, deg*pi/180, 0]
    T = robot.fkine(q)
    print(f"    q1={deg:3d}deg: x={T.t[0]:+6.1f}  y={T.t[1]:+6.1f}  z={T.t[2]:+5.1f}")

# 全軸 0deg での FK
T_zero = robot.fkine([0, 0, 0, 0, 0, 0])
print(f"\n--- 初期位置 FK (全軸 0deg) ---")
print(f"EE位置 (mm): x={T_zero.t[0]:.1f}  y={T_zero.t[1]:.1f}  z={T_zero.t[2]:.1f}")

# 初期位置での FK（teach の開始姿勢）
T_home = robot.fkine(q_home)
print(f"\n--- 初期姿勢 FK (q_home) ---")
print(f"EE位置 (mm): x={T_home.t[0]:.1f}  y={T_home.t[1]:.1f}  z={T_home.t[2]:.1f}")
print("期待値      : 未設定 (全軸 0deg を初期位置として使用)")
print("誤差合計    : 評価なし")
print(f"ワーク箱中心: x={work_center[0]:.1f}  y={work_center[1]:.1f}  z={work_center[2]:.1f} mm")
print(f"ワーク箱寸法: x={work_size[0]:.1f}  y={work_size[1]:.1f}  z={work_size[2]:.1f} mm")
print(f"把持目標点  : x={grasp_target[0]:.1f}  y={grasp_target[1]:.1f}  z={grasp_target[2]:.1f} mm")
print(f"把持接近軸  : z=[{grasp_z_axis[0]:.1f}, {grasp_z_axis[1]:.1f}, {grasp_z_axis[2]:.1f}]")
print(f"目標EE姿勢RPY[deg]: roll={grasp_pose.rpy(unit='deg', order='zyx')[0]:.1f}  pitch={grasp_pose.rpy(unit='deg', order='zyx')[1]:.1f}  yaw={grasp_pose.rpy(unit='deg', order='zyx')[2]:.1f}")
grasp_delta = grasp_target - T_home.t
print(f"EE→目標差分 : dx={grasp_delta[0]:+.1f}  dy={grasp_delta[1]:+.1f}  dz={grasp_delta[2]:+.1f} mm")
print(f"EE→目標距離 : {np.linalg.norm(grasp_delta):.1f} mm")
home_rpy = T_home.rpy(unit='deg', order='zyx')
print(f"現在EE姿勢RPY[deg]: roll={home_rpy[0]:.1f}  pitch={home_rpy[1]:.1f}  yaw={home_rpy[2]:.1f}")

ik_sol = solve_ik(robot, grasp_pose, q_home)
print("\n--- IK 結果 (grasp_pose) ---")
print(f"success      : {ik_sol.success}")
print(f"iterations   : {ik_sol.iterations}")
print(f"searches     : {ik_sol.searches}")
print(f"residual     : {ik_sol.residual:.3e}")
if ik_sol.success:
    ik_q_deg = np.rad2deg(ik_sol.q)
    print("q[deg]       : " + "  ".join(f"{angle:+7.2f}" for angle in ik_q_deg))
    T_ik = robot.fkine(ik_sol.q)
    ik_delta = grasp_target - T_ik.t
    ik_rpy = T_ik.rpy(unit='deg', order='zyx')
    print(f"IK EE位置    : x={T_ik.t[0]:.1f}  y={T_ik.t[1]:.1f}  z={T_ik.t[2]:.1f} mm")
    print(f"IK EE姿勢RPY : roll={ik_rpy[0]:.1f}  pitch={ik_rpy[1]:.1f}  yaw={ik_rpy[2]:.1f} deg")
    print(f"IK→目標差分  : dx={ik_delta[0]:+.3f}  dy={ik_delta[1]:+.3f}  dz={ik_delta[2]:+.3f} mm")
else:
    T_ik = None

# インタラクティブ 3D 表示（スライダー付き）
# teach() のスライダーラベルは 0-indexed: q0=J1, q1=J2, q2=J3, q3=J4, q4=J5, q5=J6
print("\nスライダーラベル対応 (0-indexed):")
labels_map = ["q0=J1 旋回", "q1=J2 肩ピッチ", "q2=J3 肘", "q3=J4 前腕", "q4=J5 手首ピッチ", "q5=J6 手首ロール"]
for s in labels_map:
    print(f"  {s}")
print("\nワーク箱付き 3D ビューを起動中...")
show_robot_with_work(robot, q_home, work_center, work_size, grasp_target, grasp_pose)
if ik_sol.success:
    print("IK 解の 3D ビューを起動中...")
    show_robot_with_work(robot, ik_sol.q, work_center, work_size, grasp_target, grasp_pose)
print("\n3D ビューアを起動中... ウィンドウを閉じると終了します。")
robot.teach(q_home, block=True)
