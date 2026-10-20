/**
 * brain3d.js — 昔涟脑图 3D 渲染器
 *
 * 素材：真实人脑解剖模型（437 个独立命名网格，CC 授权，
 *       来源 itayinbarr/brainproject，经 glTF-Transform 处理）。
 *
 * 分区策略：模型自带的解剖学名字就是最好的分区依据。
 *   额叶 / 顶叶 / 枕叶 / 颞叶 / 边缘系统 五区直接按名字正则归类，
 *   比按坐标硬切准确得多，也不会出现「一个脑回被劈成两半」。
 *
 * 联动特效（这是本文件重点）：
 *   1. 区域能量 → 该区所有网格的自发光强度 + 颜色饱和度
 *   2. 区域之间画弧线，线上一串光点在流动，光点数量按边权决定
 *   3. 正在扩散的区，整体呼吸脉动（sin 波动）
 *   4. 当前所在区的外壳会「点亮」，其余区压暗
 */

import * as THREE from "./vendor/three.module.min.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { DRACOLoader } from "./vendor/DRACOLoader.js";

/* ============================================================
   五区定义 · 按解剖名归类
   ============================================================ */

export const REGIONS = [
  {
    id: "association",
    name: "联合区",
    lobe: "额叶",
    hint: "组织与决策",
    color: 0xffb84d,
    match: /frontal|orbitofrontal|precentral|opercul|triangular/i,
  },
  {
    id: "sensory",
    name: "感觉区",
    lobe: "顶叶",
    hint: "看与听",
    color: 0x5b9bff,
    /*
     * 关于 paracentral：旁中央沟是顶叶的细长纵向结构，包围盒中心偏前，
     * 坐标兜底会把它算成靠近额叶。这是「包围盒中心 ≠ 解剖位置」的典型例子，
     * 只有名字能纠正。
     *
     * 这里刻意只写 paracentral 一个词。角回（angular）、缘上回（supramarginal）
     * 虽然名字里没有 parietal，但坐标兜底本来就判对了，补进去是重复劳动；
     * 而 central sulcus / angular / parieto-occipital 这类宽泛写法会误伤：
     *   central sulcus  → 命中 Precentral sulcus（额叶，按字母子串匹配）
     *   angular         → 命中 Triangular part of inferior frontal gyrus（额叶）
     * 加新词前先跑 brain-geometry-test，里面有守卫断言。
     */
    match: /parietal|postcentral|intraparietal|subparietal|precuneus|paracentral/i,
  },
  {
    id: "motor",
    name: "运动区",
    lobe: "枕叶",
    hint: "动手改变世界",
    color: 0xff5b8a,
    match: /occipital|cuneus|lingual|calcarine/i,
  },
  {
    id: "memory",
    name: "记忆区",
    lobe: "颞叶",
    hint: "记住与复用",
    color: 0x9b6bff,
    match: /temporal|hippocamp|parahippocamp|fusiform|uncus/i,
  },
  {
    id: "limbic",
    name: "边缘区",
    lobe: "边缘系统",
    hint: "本能与情绪",
    color: 0x4bb377,
    match: /cingulat|thalam|hypothalam|amygdal|fornix|septum|insula|corpus callosum/i,
  },
];

/**
 * 这些网格不参与脑区分色，直接隐藏。
 *
 * 模型是神经血管解剖图谱，437 个网格里大半是动脉、静脉窦、颅神经、
 * 软骨和骨。它们名字里没有脑叶信息，留着会让默认区吞掉 88% 的顶点，
 * 整颗脑被染成一个颜色——这正是上一版「全黄」的原因。
 */
const EXCLUDE = /artery|arteries|sinus|plexus|vein|venous|nerve|nerve|bone|cartilage|tentorium|falx|dura|vessel/i;

/**
 * 判断一个网格是否该隐藏。
 * 血管与神经要剔除；纯「脑组织」留下。
 */
export function shouldHide(name) {
  if (!name) return false;
  return EXCLUDE.test(name);
}

/**
 * 一个节点归到哪个区。
 *
 * 两段式：
 *   1. 名字里有脑叶关键词 → 直接归属（最准，解剖学命名）
 *   2. 名字里没有 → 用顶点坐标做空间归类（额叶在前、枕叶在后、
 *      顶叶在上、颞叶在下、深部归边缘系统）
 *
 * 第一版只用了第 1 段，没命中的全塞进默认区，导致严重的颜色失衡。
 */
export function regionOfNodeName(name) {
  if (!name) return null;
  for (const r of REGIONS) {
    if (r.match.test(name)) return r.id;
  }
  return null;
}

/**
 * 五区解剖质心（可见脑组织归一化坐标，x 左右 / y 上下 / z 前后）。
 *
 * 这些数字不是拍脑袋定的：用 GLB 里 158 个带解剖名的网格实测求平均得到，
 * 所以「按最近质心归类」与解剖命名保持一致。
 * 改了模型就得重新量——geometry 自检会盯着这一点。
 */
export const REGION_CENTROIDS = {
  association: [0.0, 0.38, 0.3],
  sensory: [0.0, 0.43, -0.39],
  motor: [0.0, 0.03, -0.62],
  memory: [0.0, -0.06, -0.11],
  limbic: [0.0, 0.17, 0.03],
};

/** 边缘系统是深部结构：靠近中线、且离自身质心足够近才算 */
const LIMBIC_MAX_ABS_X = 0.16;
const LIMBIC_RADIUS = 0.42;

/**
 * 空间兜底：按归一化 3D 坐标判断落在哪个区。
 *
 * 坐标系取自模型自身：x 左右、y 上下、z 前后。
 *
 * 旧版用一串 if 阈值分层（顶部→顶叶、靠前→额叶…），实测是坏的：
 * 190 个没有解剖名的网格里 126 个被判成边缘区、39 个感觉区，
 * 记忆区一个都没分到 —— 阈值和真实坐标分布对不上。
 * 现在改成「离哪个区的解剖质心最近就归哪个区」，
 * 深部结构额外用中线宽度与半径门限拦一道。
 */
export function regionOfPoint(nx, ny, nz) {
  const dLimbic = Math.hypot(nx, ny - REGION_CENTROIDS.limbic[1], nz - REGION_CENTROIDS.limbic[2]);
  if (Math.abs(nx) < LIMBIC_MAX_ABS_X && dLimbic < LIMBIC_RADIUS) return "limbic";

  let best = "sensory";
  let bestD = Infinity;
  for (const id of ["association", "sensory", "motor", "memory"]) {
    const c = REGION_CENTROIDS[id];
    const d = Math.hypot(nx - c[0], ny - c[1], nz - c[2]);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/* ============================================================
   渲染器
   ============================================================ */

export class Brain3D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   *   - onReady()            模型加载完成
   *   - onProgress(ratio)    加载进度
   *   - onError(err)
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.clock = null;

    /** regionId -> { meshes: [], center: Vector3, energy: 0..1, target: 0..1 } */
    this.regions = new Map();

    /** 所有网格，方便统一更新 */
    this.allMeshes = [];

    /** 连接弧线与流动光点 */
    this.links = [];

    this.running = false;
    this.ready = false;

    /** 旋转控制 */
    this.spin = { yaw: -0.35, pitch: 0.12, autoSpin: true, dragging: false, lx: 0, ly: 0 };

    this._init();
  }

  /* ---------------- 初始化 ---------------- */

  _init() {
    const { canvas } = this;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();

    // 相机：略高于赤道，俯视 40° 能同时看到额叶顶部与颞叶侧面
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(0, 0, 5.2);

    this.clock = new THREE.Clock();

    // 三盏灯：主光从右上、补光从左下、轮廓光从背后
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3, 4, 5);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xbcd6ff, 0.9);
    fill.position.set(-4, -2, 2);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffc6dd, 1.1);
    rim.position.set(-2, 3, -6);
    this.scene.add(rim);

    this.scene.add(new THREE.AmbientLight(0xfff2f7, 0.55));

    // 脑内部一点微光，避免模型背光面全黑
    const inner = new THREE.PointLight(0xff9ec4, 1.4, 8);
    inner.position.set(0, 0, 0);
    this.scene.add(inner);

    this._bindPointer();
    this._bindResize();
  }

  _bindResize() {
    const resize = () => {
      const w = this.canvas.clientWidth || 800;
      const h = this.canvas.clientHeight || 600;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    this._resize = resize;
    window.addEventListener("resize", resize);
    // 面板首次布局完成后再量一次
    setTimeout(resize, 60);
    setTimeout(resize, 400);
  }

  _bindPointer() {
    const c = this.canvas;
    const spin = this.spin;

    c.addEventListener("pointerdown", (e) => {
      spin.dragging = true;
      spin.lx = e.clientX;
      spin.ly = e.clientY;
      spin.autoSpin = false;
      c.setPointerCapture?.(e.pointerId);
    });

    c.addEventListener("pointermove", (e) => {
      if (!spin.dragging) return;
      const dx = e.clientX - spin.lx;
      const dy = e.clientY - spin.ly;
      spin.lx = e.clientX;
      spin.ly = e.clientY;
      spin.yaw += dx * 0.006;
      spin.pitch = Math.max(-1.1, Math.min(1.1, spin.pitch + dy * 0.005));
    });

    const end = () => {
      spin.dragging = false;
      // 松手 3 秒后恢复自转
      clearTimeout(this._spinTimer);
      this._spinTimer = setTimeout(() => {
        spin.autoSpin = true;
      }, 3000);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const z = THREE.MathUtils.clamp(this.camera.position.z + e.deltaY * 0.0025, 2.6, 9);
      this.camera.position.z = z;
    }, { passive: false });
  }

  /* ---------------- 加载模型 ---------------- */

  async load(url) {
    const loader = new GLTFLoader();

    // 这个模型用 KHR_draco_mesh_compression 压缩（563 个压缩块），
    // 必须挂 DRACOLoader，否则解析直接失败。
    // 解码器用 gltf/ 目录那套：比通用版小一半，是给 glTF 专用的。
    const draco = new DRACOLoader();
    draco.setDecoderPath("./vendor/draco/");
    draco.setDecoderConfig({ type: "wasm" });
    loader.setDRACOLoader(draco);
    this._draco = draco;

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          try {
            this._build(gltf);
            this.ready = true;
            this.opts.onReady?.();
            this.start();
            resolve(this);
          } catch (e) {
            this.opts.onError?.(e);
            reject(e);
          }
        },
        (ev) => {
          if (ev && ev.total) this.opts.onProgress?.(ev.loaded / ev.total);
        },
        (err) => {
          this.opts.onError?.(err);
          reject(err);
        },
      );
    });
  }

  _build(gltf) {
    const root = gltf.scene;

    /*
     * 归一化基准：只框住「会显示的脑组织」，不把血管/骨/神经算进去。
     *
     * 这一步以前是坏的：用 setFromObject(root) 把 437 个网格全包进来，
     * 而里面 118 个是动脉、静脉窦、颅神经和骨软骨，几何范围比脑组织
     * 宽得多。结果可见脑组织被压到归一化坐标的 y∈[0.5, 0.9] 一条带里，
     * regionOfPoint 的上下分层永远走「ny>0.28 → 顶叶」这一支，
     * 190 个没解剖名的网格全被染成感觉区。
     */
    root.updateWorldMatrix(true, true);

    const box = new THREE.Box3();
    const probe = new THREE.Box3();
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      const name = obj.name || obj.parent?.name || "";
      if (shouldHide(name)) return;
      obj.geometry.computeBoundingBox();
      if (!obj.geometry.boundingBox) return;
      probe.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
      box.union(probe);
    });
    // 兜底：模型里所有网格都被判为血管时不能崩
    if (box.isEmpty()) box.setFromObject(root);

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxEdge = Math.max(size.x, size.y, size.z) || 1;
    const scale = 3 / maxEdge;
    const half = maxEdge / 2;

    /** 归一化基准（自检脚本会读它，确认基准跟着可见网格走） */
    this.normalizeBasis = {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      center: [center.x, center.y, center.z],
      size: [size.x, size.y, size.z],
      half,
      scale,
    };

    const holder = new THREE.Group();
    holder.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    holder.scale.setScalar(scale);
    holder.add(root);
    this.scene.add(holder);
    this.holder = holder;

    // 先建区容器
    for (const r of REGIONS) {
      this.regions.set(r.id, {
        id: r.id,
        def: r,
        meshes: [],
        energy: 0,
        target: 0,
        center: new THREE.Vector3(),
        color: new THREE.Color(r.color),
      });
    }

    // 遍历所有网格
    let hidden = 0;
    root.traverse((obj) => {
      if (!obj.isMesh) return;

      const name = obj.name || obj.parent?.name || "";

      // 血管、静脉窦、颅神经、骨与软骨一律隐藏：
      // 它们占了模型大部分顶点，留着会把整颗脑染成一个颜色。
      if (shouldHide(name)) {
        obj.visible = false;
        hidden += 1;
        return;
      }

      // 先按解剖名归类；名字里没有脑叶信息时，用顶点位置兜底
      let rid = regionOfNodeName(name);
      if (!rid) {
        obj.geometry.computeBoundingBox();
        const c = new THREE.Vector3();
        obj.geometry.boundingBox.getCenter(c);
        // 注意：这里的 center / half 是「可见脑组织」的基准，不是整模型
        const nx = (c.x - center.x) / half || 0;
        const ny = (c.y - center.y) / half || 0;
        const nz = (c.z - center.z) / half || 0;
        obj.userData.normalized = [nx, ny, nz];
        rid = regionOfPoint(nx, ny, nz);
      }

      const region = this.regions.get(rid);
      if (!region) return;

      // 换材质：统一用可发光的标准材质，保留原几何
      const base = region.color.clone();
      const mat = new THREE.MeshStandardMaterial({
        color: base.clone(),
        emissive: base.clone(),
        emissiveIntensity: 0.12,
        metalness: 0.18,
        roughness: 0.62,
        transparent: true,
        opacity: 0.92,
        flatShading: false,
      });

      obj.material = mat;
      obj.userData.regionId = rid;
      obj.userData.baseColor = base.clone();
      obj.userData.name = name;

      // 记录原始变换与几何中心，供「能量放大」使用。
      //
      // 为什么需要这些：mesh.scale 是绕网格自身的局部原点缩放的，
      // 而 GLB 里这些网格的原点并不在几何中心（顶点坐标离原点很远）。
      // 直接 setScalar 会让整块顶点按「距原点的距离」被甩出去 ——
      // 靠上的区往上飞、靠下的区往下沉，看着像脑壳散架。
      // 顺便也不能直接覆盖 scale：模型自带非 1 缩放的话会被抹掉。
      obj.userData.baseScale = obj.scale.clone();
      obj.userData.basePosition = obj.position.clone();
      obj.geometry.computeBoundingBox();
      const geoCenter = new THREE.Vector3();
      obj.geometry.boundingBox.getCenter(geoCenter);
      obj.userData.geoCenter = geoCenter;

      region.meshes.push(obj);
      this.allMeshes.push(obj);
    });

    this.hiddenCount = hidden;

    // 每个区的几何中心（用于画弧线）
    for (const region of this.regions.values()) {
      if (!region.meshes.length) continue;
      const b = new THREE.Box3();
      for (const m of region.meshes) b.expandByObject(m);
      b.getCenter(region.center);
      // 顶点数作为「权重」，让区的大小真实反映解剖体量
      region.weight = region.meshes.reduce(
        (s, m) => s + (m.geometry?.attributes?.position?.count || 0),
        0,
      );
    }

    this._buildLinkLayer();
    this._buildPulseRings();
  }

  /**
   * 脉冲光环：每个区一圈，能量高时向外扩散。
   *
   * 单靠「颜色变亮」在小屏上不够醒目，加一圈扩散的光环，
   * 一眼就能看到「这个区正在启动」。
   */
  _buildPulseRings() {
    this.pulseRings = [];
    for (const region of this.regions.values()) {
      if (!region.meshes.length) continue;

      // 光环半径按该区包围盒最大边估算
      const b = new THREE.Box3();
      for (const m of region.meshes) b.expandByObject(m);
      const size = new THREE.Vector3();
      b.getSize(size);
      const r = Math.max(size.x, size.y, size.z) * 0.62 || 0.4;

      const geo = new THREE.RingGeometry(r * 0.92, r, 48);
      const mat = new THREE.MeshBasicMaterial({
        color: region.color,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(region.center);
      mesh.lookAt(this.camera.position);
      mesh.visible = false;
      this.scene.add(mesh);

      this.pulseRings.push({ regionId: region.id, mesh, phase: Math.random() });
    }
  }

  /* ---------------- 联动弧线 ---------------- */

  _buildLinkLayer() {
    this.linkGroup = new THREE.Group();
    this.scene.add(this.linkGroup);

    // 预建全部两两组合的弧线（10 对），后续按边权显隐与调节亮度
    const ids = REGIONS.map((r) => r.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.regions.get(ids[i]);
        const b = this.regions.get(ids[j]);
        if (!a?.center || !b?.center) continue;
        this.links.push(this._makeLink(a, b));
      }
    }
  }

  _makeLink(a, b) {
    const mid = a.center.clone().add(b.center).multiplyScalar(0.5);

    // 弧线抬高：让连线从脑表面外绕过去，而不是穿进内部
    const outward = mid.clone().normalize();
    if (outward.lengthSq() < 1e-6) outward.set(0, 1, 0);
    const ctrl = mid.clone().add(outward.multiplyScalar(mid.length() * 0.55 + 0.8));

    const curve = new THREE.QuadraticBezierCurve3(a.center.clone(), ctrl, b.center.clone());

    // 曲线本体：用 TubeGeometry 做成有厚度的光带。
    // 细线在 WebGL 里几乎看不见，linewidth 还被多数平台忽略，
    // 只有真几何体才能稳定显示「明显的连线」。
    const geo = new THREE.TubeGeometry(curve, 48, 0.022, 8, false);
    const mat = new THREE.MeshBasicMaterial({
      color: a.def.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Mesh(geo, mat);
    this.linkGroup.add(line);

    // 第二层更粗的半透明外管，形成柔光包裹
    const glowGeo = new THREE.TubeGeometry(curve, 48, 0.055, 8, false);
    const glowMat = new THREE.MeshBasicMaterial({
      color: a.def.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glowTube = new THREE.Mesh(glowGeo, glowMat);
    this.linkGroup.add(glowTube);

    // 流动光点：数量够多、尺寸够大，才看得出「在流动」
    const dotCount = 9;
    const dots = [];
    const dotGeo = new THREE.SphereGeometry(0.055, 12, 12);
    for (let i = 0; i < dotCount; i++) {
      const dotMat = new THREE.MeshBasicMaterial({
        color: a.def.color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.visible = false;
      this.linkGroup.add(dot);
      dots.push({ mesh: dot, t: i / dotCount, mat: dotMat });
    }

    // 光晕：一串稍大的半透明球，让流动看起来像「脉冲」而不是小点
    const haloGeo = new THREE.SphereGeometry(0.13, 12, 12);
    const glows = [];
    for (let i = 0; i < 3; i++) {
      const gMat = new THREE.MeshBasicMaterial({
        color: a.def.color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const g = new THREE.Mesh(haloGeo, gMat);
      g.visible = false;
      this.linkGroup.add(g);
      glows.push({ mesh: g, t: i / 3, mat: gMat });
    }

    return {
      from: a.id,
      to: b.id,
      curve,
      line,
      lineMat: mat,
      glowTube,
      glowMat,
      dots,
      glows,
      weight: 0,
      targetWeight: 0,
      colorA: new THREE.Color(a.def.color),
      colorB: new THREE.Color(b.def.color),
    };
  }

  /* ---------------- 状态注入 ---------------- */

  /**
   * 由 /api/brain 的数据驱动
   * @param {object} data
   *   regions: [{id, energy, count}]
   *   edges:   [{from, to, weight}]  —— 节点级，这里聚合成区级
   *   current: 当前节点 id
   *   energyMode: 'diffuse' | 'global'
   */
  setState(data) {
    if (!this.ready) return;

    const rs = data.regions || [];

    // 1. 各区能量归一化
    const maxE = Math.max(0.0001, ...rs.map((r) => r.energy || 0));
    for (const r of rs) {
      const region = this.regions.get(r.id);
      if (!region) continue;
      region.target = Math.min(1, Math.sqrt((r.energy || 0) / maxE));
      region.count = r.count || 0;
    }

    // 2. 节点级边 → 区级边权聚合
    //    注意：data.edges 的 from/to 是节点 id（形如 collect:block=oak_log），
    //    需要先从 nodes 里查出它属于哪个区。
    const nodeRegion = new Map();
    for (const n of data.nodes || []) nodeRegion.set(n.id, n.region);

    const pairW = new Map();
    let maxW = 0.0001;
    for (const e of data.edges || []) {
      const a = nodeRegion.get(e.from);
      const b = nodeRegion.get(e.to);
      if (!a || !b || a === b) continue;
      const key = [a, b].sort().join("|");
      pairW.set(key, (pairW.get(key) || 0) + (e.weight || 0));
    }
    for (const w of pairW.values()) maxW = Math.max(maxW, w);

    for (const link of this.links) {
      const key = [link.from, link.to].sort().join("|");
      const w = pairW.get(key) || 0;
      // 平方根压缩，避免最强的一条边把其他都压成看不见
      link.targetWeight = Math.min(1, Math.sqrt(w / maxW));
    }

    this.currentNode = data.current || "";
    this.energyMode = data.energyMode || "diffuse";
  }

  /* ---------------- 动画循环 ---------------- */

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      this._tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  _tick() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;

    // 自转
    if (this.spin.autoSpin && !this.spin.dragging) {
      this.spin.yaw += dt * 0.18;
    }
    if (this.holder) {
      this.holder.rotation.y = this.spin.yaw;
      this.holder.rotation.x = this.spin.pitch;
    }

    // 每区能量平滑 + 材质更新
    for (const region of this.regions.values()) {
      region.energy += (region.target - region.energy) * Math.min(1, dt * 5);

      const e = region.energy;

      // 呼吸脉动：能量越高，脉动越明显
      const breathe = 1 + Math.sin(t * 2.6 + region.center.x * 2) * 0.28 * e;

      // 发光强度：静息 0.1 → 满能量 2.2，配合呼吸
      const em = 0.1 + e * 2.1 * breathe;

      // 颜色饱和度：低能量偏灰，高能量饱满
      const sat = 0.25 + e * 0.75;

      for (const m of region.meshes) {
        const mat = m.material;
        if (!mat) continue;

        mat.emissiveIntensity = em;
        mat.emissive.copy(region.color).multiplyScalar(0.4 + e * 0.6);

        // 底色：能量低时压灰，能量高时接近纯本区色
        mat.color.copy(m.userData.baseColor).lerp(new THREE.Color(0x9a9aa8), (1 - sat) * 0.65);

        // 能量高的区微微放大。
        //
        // 这里必须绕「几何中心」缩放，不能直接 setScalar ——
        // 网格的局部原点不在几何中心，直接缩会把顶点按距原点的距离甩出去，
        // 靠上的区往上飞、靠下的区往下沉。补偿项 position += geoCenter*(1-s)
        // 恰好抵消这部分的位移；同时保留模型自带的原始缩放，不覆盖。
        const s = 1 + e * 0.05 * breathe;
        m.scale.copy(m.userData.baseScale).multiplyScalar(s);
        m.position
          .copy(m.userData.basePosition)
          .addScaledVector(m.userData.geoCenter, 1 - s);
      }
    }

    // 弧线与光点
    let anyLink = false;
    for (const link of this.links) {
      link.weight += (link.targetWeight - link.weight) * Math.min(1, dt * 4);

      const w = link.weight;
      if (w > 0.02) anyLink = true;

      // 弧线本体：管状光带，权重越高越亮
      link.lineMat.opacity = 0.12 + w * 0.85;
      const mixed = link.colorA.clone().lerp(link.colorB, 0.5);
      link.lineMat.color.copy(mixed).multiplyScalar(0.8 + w * 0.6);
      link.glowMat.opacity = 0.04 + w * 0.22;
      link.glowMat.color.copy(mixed);

      // 主光点：沿曲线流动
      const speed = 0.22 + w * 0.75;
      link.dots.forEach((d, i) => {
        if (w < 0.02) {
          d.mesh.visible = false;
          return;
        }
        d.mesh.visible = true;
        d.t = (d.t + dt * speed) % 1;

        const p = link.curve.getPointAt(d.t);
        d.mesh.position.copy(p);

        // 两端淡出、中段最亮：形成「从 A 冲出来扎进 B」的感觉
        const fade = Math.sin(d.t * Math.PI);
        const pulse = 0.5 + 0.5 * Math.sin(t * 6 + i);
        d.mesh.scale.setScalar((0.85 + w * 1.7) * (0.45 + fade * 0.85));
        d.mat.opacity = w * (0.18 + fade * 0.82);
        d.mat.color.copy(link.colorA).lerp(link.colorB, d.t);
      });

      // 光晕：更大更淡，套在主点外面，营造辉光
      link.glows.forEach((g, i) => {
        if (w < 0.12) {
          g.mesh.visible = false;
          return;
        }
        g.mesh.visible = true;
        g.t = (g.t + dt * speed * 0.85) % 1;
        const p = link.curve.getPointAt(g.t);
        g.mesh.position.copy(p);
        const fade = Math.sin(g.t * Math.PI);
        g.mesh.scale.setScalar(1 + fade * 1.6);
        g.mat.opacity = w * fade * 0.28;
        g.mat.color.copy(link.colorA).lerp(link.colorB, g.t);
      });
    }

    // 「当前正在联动」的区：额外加一层外扩光环
    if (this.pulseRings && this.pulseRings.length) {
      for (const ring of this.pulseRings) {
        const region = this.regions.get(ring.regionId);
        if (!region) continue;
        const e = region.energy;
        ring.mesh.visible = e > 0.08;
        if (!ring.mesh.visible) continue;

        // 光环从区域中心向外扩散，循环
        ring.phase = (ring.phase + dt * (0.6 + e * 0.9)) % 1;
        const s = 0.6 + ring.phase * 1.8;
        ring.mesh.scale.setScalar(s);
        ring.mesh.material.opacity = (1 - ring.phase) * e * 0.5;
        ring.mesh.material.color.copy(region.color);
      }
    }

    this.renderer.render(this.scene, this.camera);

    // 光环始终朝向相机，否则侧看时会变成一条线
    if (this.pulseRings) {
      for (const ring of this.pulseRings) {
        ring.mesh.quaternion.copy(this.camera.quaternion);
      }
    }
  }

  /* ---------------- 区级高亮 ---------------- */

  /** 只让某个区亮起来，其余压暗（传 null 恢复） */
  spotlight(regionId) {
    this.spotlightId = regionId;
    for (const region of this.regions.values()) {
      const on = !regionId || region.id === regionId;
      for (const m of region.meshes) {
        if (!m.material) continue;
        m.material.opacity = on ? 0.95 : 0.16;
        m.material.transparent = true;
      }
    }
  }

  /** 某个区当前的统计（供 HUD 用） */
  stats() {
    const out = [];
    for (const region of this.regions.values()) {
      out.push({
        id: region.id,
        name: region.def.name,
        lobe: region.def.lobe,
        meshes: region.meshes.length,
        energy: region.energy,
        target: region.target,
        count: region.count || 0,
        color: `#${region.def.color.toString(16).padStart(6, "0")}`,
      });
    }
    return out;
  }

  dispose() {
    this.stop();
    window.removeEventListener("resize", this._resize);
    this.renderer?.dispose();
  }
}
