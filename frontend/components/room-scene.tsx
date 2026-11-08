"use client";

import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Color, DoubleSide } from "three";
import type { Group, Mesh, MeshBasicMaterial } from "three";
import {
  ROOM_AIRCON_MOUNTS,
  ROOM_APPLIANCE_ACTIVE_COLOR,
  ROOM_APPLIANCE_IDLE_COLOR,
  ROOM_CEILING_LIGHTS,
  ROOM_FURNITURE,
  ROOM_WALL_PARTS,
  roomTemperatureColor,
  type ResolvedRoomZone,
  type RoomBoxPart,
  type RoomFloorTone,
  type RoomLayerState,
  type RoomSurfaceTone,
} from "@/lib/room-layout";
import { formatAirconMode, getAirconModeColor, isAirconPowerOff } from "@/lib/types";

/**
 * 部屋の3Dビュー本体（#399）。
 *
 * 間取りは実物の2LDK（#406）で、寸法は `lib/room-layout.ts` が持っている。図面を直すときは
 * そちらのデータを置き換えるだけで済むよう、ここは受け取った箱・壁・ゾーンを描くだけにしてあり、
 * **外から渡すのはゾーンのキーと値だけ**にしてある。
 *
 * 文字は3Dの中に描かず、`<Html>` でDOMとして重ねる。3Dのテキストは視点を回すと
 * 裏返って読めなくなるうえ、テーマごとの色・フォントを画面の他の場所と揃えられない。
 *
 * `output: "export"` の静的書き出しなので、このファイルは必ずクライアント側だけで動く
 * （呼び出し側が `next/dynamic` の `ssr: false` で読む）。
 */

type RoomScenePalette = Record<RoomSurfaceTone | RoomFloorTone | "fixture", string>;

const PALETTES: Record<"light" | "dark", RoomScenePalette> = {
  light: {
    floor: "#e7e2d8",
    tatami: "#b7c39a",
    balcony: "#d3cfc7",
    wall: "#f2efe9",
    partition: "#e6e1d7",
    wood: "#cfc7b8",
    woodDark: "#b9afa0",
    metal: "#d9dde2",
    screen: "#5b626c",
    glass: "#9fc4dc",
    fixture: "#ffffff",
  },
  dark: {
    floor: "#55504a",
    tatami: "#57634a",
    balcony: "#46423d",
    wall: "#6b6660",
    partition: "#5c5751",
    wood: "#7d766c",
    woodDark: "#6a6459",
    metal: "#8a9099",
    screen: "#3b4048",
    glass: "#6f93ab",
    fixture: "#f2ede2",
  },
};

/** ガラスの透け具合。窓越しに部屋の中が見える程度で、手すりとしても読める濃さ */
const GLASS_OPACITY = 0.32;

/**
 * 床に敷く色。温度そのままだと彩度が高すぎるので、床の地の色へ寄せる。
 * 地の色はゾーンごと（畳・バルコニー）に違うので、パレットではなく色そのものを受け取る。
 * 温度レイヤがオンでも地の色が残り、オフのときは素の床色に戻る。
 */
function floorColor(base: string, temperature: number | null, tinted: boolean): string {
  if (!tinted || temperature == null) return base;
  return `#${new Color(roomTemperatureColor(temperature)).lerp(new Color(base), 0.42).getHexString()}`;
}

/** 壁・家具の1つ。ガラスだけ半透明にし、円柱は `size[0]` を直径として描く */
function RoomBox({ part, palette }: { part: RoomBoxPart; palette: RoomScenePalette }) {
  const color = palette[part.tone];
  return (
    <mesh position={part.position}>
      {part.shape === "cylinder" ? (
        <cylinderGeometry args={[part.size[0] / 2, part.size[0] / 2, part.size[1], 24]} />
      ) : (
        <boxGeometry args={part.size} />
      )}
      {part.tone === "glass" ? (
        <meshLambertMaterial color={color} transparent opacity={GLASS_OPACITY} depthWrite={false} />
      ) : (
        <meshLambertMaterial color={color} />
      )}
    </mesh>
  );
}

interface RoomSceneProps {
  zones: readonly ResolvedRoomZone[];
  layers: RoomLayerState;
  /** 一覧で選んでいる場所。3D側で床を光らせる */
  focusKey: string | null;
  dark: boolean;
  /** 狭い画面。カメラを少し引いて部屋全体が入るようにする */
  compact: boolean;
  reduceMotion: boolean;
  onSelectZone: (key: string) => void;
}

/**
 * 見下ろす角度（ラジアン）。真上からだと壁で中が隠れ、低すぎると奥の部屋が見えない。
 * 方位は負にして、バルコニー側の手前（X が負・Z が正）から見下ろす。玄関側が奥になる。
 * 回転の中心はバルコニーを含めた間取りの中央（X が少し負）に置く
 */
const CAMERA_ELEVATION = 0.78;
const CAMERA_AZIMUTH = -0.62;
const CAMERA_TARGET: [number, number, number] = [-0.4, 0.3, 0];

function cameraPosition(distance: number): [number, number, number] {
  return [
    CAMERA_TARGET[0] + distance * Math.cos(CAMERA_ELEVATION) * Math.sin(CAMERA_AZIMUTH),
    CAMERA_TARGET[1] + distance * Math.sin(CAMERA_ELEVATION),
    CAMERA_TARGET[2] + distance * Math.cos(CAMERA_ELEVATION) * Math.cos(CAMERA_AZIMUTH),
  ];
}

export function RoomScene({
  zones,
  layers,
  focusKey,
  dark,
  compact,
  reduceMotion,
  onSelectZone,
}: RoomSceneProps) {
  const palette = PALETTES[dark ? "dark" : "light"];
  const distance = compact ? 16.4 : 13.6;

  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true }}
      camera={{ fov: 38, near: 0.1, far: 200, position: cameraPosition(distance) }}
      aria-label="部屋の3D表示"
    >
      <ambientLight intensity={dark ? 0.66 : 0.78} />
      <directionalLight position={[6, 12, 8]} intensity={dark ? 0.5 : 0.62} />
      <directionalLight position={[-8, 5, -6]} intensity={0.24} color="#bcd4e8" />

      {ROOM_WALL_PARTS.map((part, index) => (
        <RoomBox key={`wall-${index}`} part={part} palette={palette} />
      ))}

      {ROOM_FURNITURE.map((part, index) => (
        <RoomBox key={`furniture-${index}`} part={part} palette={palette} />
      ))}

      {zones.map((zone) => (
        <RoomZoneParts
          key={zone.key}
          zone={zone}
          layers={layers}
          palette={palette}
          focused={focusKey === zone.key}
          reduceMotion={reduceMotion}
          onSelect={onSelectZone}
        />
      ))}

      <OrbitControls
        target={CAMERA_TARGET}
        enablePan={false}
        minDistance={7}
        maxDistance={26}
        minPolarAngle={0.22}
        maxPolarAngle={1.35}
        makeDefault
      />
    </Canvas>
  );
}

interface RoomZonePartsProps {
  zone: ResolvedRoomZone;
  layers: RoomLayerState;
  palette: RoomScenePalette;
  focused: boolean;
  reduceMotion: boolean;
  onSelect: (key: string) => void;
}

function RoomZoneParts({
  zone,
  layers,
  palette,
  focused,
  reduceMotion,
  onSelect,
}: RoomZonePartsProps) {
  const [centerX, centerZ] = zone.center;
  const width = zone.rect.x1 - zone.rect.x0;
  const depth = zone.rect.z1 - zone.rect.z0;
  const shortSide = Math.min(width, depth);
  const floorTop = zone.raise;

  const airconMount = zone.acId != null ? ROOM_AIRCON_MOUNTS[zone.key] : undefined;
  const airconOn = zone.aircon != null && !isAirconPowerOff(zone.aircon.power);
  const airconColor = getAirconModeColor(zone.aircon?.mode);

  const ceiling = ROOM_CEILING_LIGHTS[zone.key];
  const lightOn = zone.light?.status === "on";
  // 器具と光の円錐は部屋の広さに合わせる。トイレ・洗面所のような1畳前後の場所に
  // LDKと同じ大きさで置くと、器具が天井を埋め、円錐が隣の部屋まではみ出す
  const lampRadius = Math.min(0.42, Math.max(0.16, shortSide * 0.22));
  const coneRadius = Math.min(1.75, Math.max(0.3, shortSide / 2 - 0.08));

  return (
    <group>
      {/* 床。温度の色を敷き、押すとその場所を選ぶ。玄関は上がり框ぶん高く、バルコニーは低い */}
      <mesh
        position={[centerX, -0.06 + floorTop, centerZ]}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(zone.key);
        }}
      >
        <boxGeometry args={[width - 0.04, 0.12, depth - 0.04]} />
        <meshLambertMaterial
          color={floorColor(palette[zone.floor], zone.temperature, layers.temperature)}
          emissive={focused ? "#1b3d55" : "#000000"}
        />
      </mesh>

      {focused ? (
        <mesh rotation-x={-Math.PI / 2} position={[centerX, 0.02 + floorTop, centerZ]}>
          <planeGeometry args={[width - 0.1, depth - 0.1]} />
          <meshBasicMaterial
            color="#3498db"
            transparent
            opacity={0.16}
            side={DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ) : null}

      {/*
        エアコン。本体・風・ピンを同じ回転の中に入れる。壁の向きに合わせて本体だけ回すと、
        風が壁の外へ流れてピンが本体の裏に出る（#406）。運転中だけ吹き出し口がモードの色で光る
      */}
      {airconMount ? (
        <group position={airconMount.position} rotation-y={airconMount.rotationY}>
          <mesh>
            <boxGeometry args={[1.05, 0.3, 0.26]} />
            <meshLambertMaterial color={palette.fixture} />
          </mesh>
          <mesh position={[0, -0.12, 0.14]}>
            <boxGeometry args={[0.92, 0.08, 0.06]} />
            <meshLambertMaterial
              color={airconColor}
              emissive={layers.aircon && airconOn ? airconColor : "#000000"}
            />
          </mesh>
          {layers.aircon && airconOn && !reduceMotion ? <AirconAirflow color={airconColor} /> : null}
          {layers.aircon && zone.aircon ? (
            <RoomPin
              position={[0, 0.44, 0.14]}
              color={airconOn ? airconColor : "#93999f"}
              name={airconOn ? formatAirconMode(zone.aircon.mode) : "エアコン"}
              value={
                airconOn && zone.aircon.target_temperature != null
                  ? `${zone.aircon.target_temperature}℃`
                  : "停止中"
              }
              highlighted={focused}
            />
          ) : null}
        </group>
      ) : null}

      {/* シーリングライト。点灯していれば光の円錐を落とす */}
      {ceiling ? (
        <group>
          <mesh position={ceiling}>
            <cylinderGeometry args={[lampRadius, lampRadius, 0.08, 24]} />
            <meshLambertMaterial
              color={palette.fixture}
              emissive={layers.light && lightOn ? "#e8a13a" : "#000000"}
            />
          </mesh>
          {layers.light && lightOn ? (
            <mesh position={[ceiling[0], ceiling[1] - 0.98, ceiling[2]]}>
              <coneGeometry args={[coneRadius, 1.94, 28, 1, true]} />
              <meshBasicMaterial
                color="#e8a13a"
                transparent
                opacity={0.13}
                side={DoubleSide}
                depthWrite={false}
              />
            </mesh>
          ) : null}
        </group>
      ) : null}

      {/* 値のピン。3Dの中ではなくDOMとして重ねる */}
      {layers.temperature && zone.temperature != null ? (
        <RoomPin
          position={[centerX, 1.02, centerZ]}
          color={roomTemperatureColor(zone.temperature)}
          name={zone.name}
          value={`${zone.temperature.toFixed(1)}℃`}
          highlighted={focused}
        />
      ) : null}

      {layers.light && ceiling && zone.light ? (
        <RoomPin
          position={[ceiling[0], ceiling[1] + 0.38, ceiling[2]]}
          color={lightOn ? "#e8a13a" : "#93999f"}
          name="照明"
          value={lightOn ? "点灯" : "消灯"}
          highlighted={focused}
        />
      ) : null}

      {/*
        紐付けたスマートプラグ。照明・エアコンと同じく、動作中かどうかに関わらずピンを出す
        （動作中だけ出すと「待機中」と「紐付けていない」が見分けられない・#410）。複数あれば横に並べる
      */}
      {layers.appliance
        ? zone.appliances.map((appliance, index) => (
            <RoomPin
              key={appliance.source}
              position={[
                centerX + (index - (zone.appliances.length - 1) / 2) * 0.9,
                1.55,
                centerZ - 0.5,
              ]}
              color={appliance.active ? ROOM_APPLIANCE_ACTIVE_COLOR : ROOM_APPLIANCE_IDLE_COLOR}
              name={appliance.label}
              value={appliance.active ? "動作中" : "待機中"}
              highlighted={focused}
            />
          ))
        : null}
    </group>
  );
}

interface RoomPinProps {
  position: [number, number, number];
  color: string;
  name: string;
  value: string;
  highlighted: boolean;
}

/**
 * 3D上の1点に添える小さな札。**押せない**（`pointer-events: none`）。
 * 3Dの上で押せるのは床だけにして、狙いにくい小さな的を作らない。
 */
function RoomPin({ position, color, name, value, highlighted }: RoomPinProps) {
  return (
    <Html position={position} zIndexRange={[30, 10]} style={{ pointerEvents: "none" }}>
      <div
        className={`-translate-x-4 -translate-y-full whitespace-nowrap rounded-full border bg-card/90 py-1 pl-2 pr-2.5 text-[11px] leading-tight shadow-sm backdrop-blur-sm ${
          highlighted ? "ring-2 ring-[var(--temp-color)]" : ""
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <span className="text-muted-foreground">{name}</span>
          <span className="font-semibold tabular-nums text-foreground">{value}</span>
        </span>
      </div>
    </Html>
  );
}

/**
 * エアコンの風。運転中であることを、色だけでなく動きでも伝える。
 * 本体と同じ回転つきの `<group>` の中に置く前提で、座標は本体から見た向き（+Z が吹き出し口）。
 * `prefers-reduced-motion` のときは呼び出し側がこれ自体を描かない。
 */
function AirconAirflow({ color }: { color: string }) {
  const group = useRef<Group>(null);

  useFrame(({ clock }) => {
    const node = group.current;
    if (!node) return;
    const elapsed = clock.getElapsedTime();
    node.children.forEach((child, index) => {
      const progress = (elapsed * 0.34 + index / node.children.length) % 1;
      child.position.set(progress * 1.15, -progress * 0.72, progress * 1.5);
      child.scale.setScalar(0.6 + progress * 1.5);
      const material = (child as Mesh).material as MeshBasicMaterial;
      material.opacity = 0.3 * (1 - progress) * Math.min(progress * 5, 1);
    });
  });

  return (
    <group ref={group}>
      {[0, 1, 2, 3].map((index) => (
        <mesh key={index} rotation-x={-Math.PI / 2.6}>
          <circleGeometry args={[0.2, 20]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0}
            side={DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}
