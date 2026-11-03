# 技術設計（実装担当向け）

WebGL 一人称ホラー。**Vite + TypeScript + three.js (r187, WebGLRenderer)**。3D モデルは **Blender 5.2 の Python スクリプト**でプロシージャル生成し GLB で読み込む。音はすべて WebAudio で**数式から合成**（外部音源ファイルなし）。

```
npm run dev        # http://127.0.0.1:5173  (dev では window.__kao デバッグAPIあり)
npm run typecheck  # tsc
npm run build      # typecheck + vite build → dist/
npm run assets     # Blender で tools/blender/models/*.py を全部実行 → public/models/*.glb + manifest.json
npm run assets -- interior --preview   # ファイル名に interior を含むものだけ。プレビューPNGも出す
npm run validate   # 章スクリプトが参照するID（小道具・アンカー・ゾーン・文書・アイテム・効果音・章…）が全部存在するか静的検査
```

## ディレクトリと担当

| パス | 内容 |
|---|---|
| `src/core/` | Engine(低解像度描画+レトロポストエフェクト) / Input / Player(FPS移動) / Collision(2.5D AABB) |
| `src/world/` | `layout.ts`(町全体の配置データ) / `World.ts`(構築・照明・NPC) / `Prop.ts`(扉などの可動部) / `Lights.ts` / `Sky.ts` / `textures.ts`(構造用キャンバステクスチャ) / `textures_content.ts`(張り紙・看板など物語用テクスチャ) / `catalog.json`(3Dモデル仕様) |
| `src/audio/` | `AudioEngine.ts` / `synth.ts`(合成ツール) / `sounds.ts`(最小セット) / `sounds_lib.ts`(全効果音ライブラリ) |
| `src/game/` | `Game.ts`(全体進行) / `Ctx.ts`(**章スクリプトAPI**) / `Chapter.ts` / `defaults.ts`(既定のインタラクト) / `face/`(「顔」) / `Flashlight.ts` / `Interaction.ts` / `State.ts` |
| `src/game/chapters/` | 章ごとのスクリプト。`index.ts` の配列順が物語順 |
| `src/game/content/` | `items.ts` `docs.ts` `shops.ts` `endings.ts` `meta.ts`(タイトル・TIPS・クレジット) |
| `src/ui/UI.ts`, `src/styles.css` | DOM オーバーレイ UI |
| `tools/blender/common.py` | Blender ヘルパー（**three.js 座標で書ける**） |
| `tools/blender/models/*.py` | モデル生成スクリプト（1ファイルに複数モデル可） |

## 座標と向き

- メートル単位、Y 上、X 東、Z 南（北は -Z）。
- **yaw（度）はカメラ基準**: 0=北(-Z)を向く、90=西(-X)、-90=東(+X)、180=南(+Z)。NPC・アンカー・スポーンの yaw も同じ。
- モデルの正面は three.js の +Z（Blender では -Y）。配置の `rot` はモデルの Y 回転（度）。
- 103号室: x∈[-22,-18], z∈[7,15]。玄関は北（外廊下側 z=7）、ベランダの掃き出し窓は南（z=15）。

## 章スクリプト API（`Ctx`、変数名 `c`）

章は `ChapterDef`（`src/game/Chapter.ts`）:

```ts
export const ch1_night: ChapterDef = {
  id: 'ch1_night', title: '一日目', subtitle: '午前三時',
  time: 'night',                 // 'night' | 'day' | 'evening' | 'dawn'
  spawn: 'spawn_bed',            // layout.spawns のID か { pos:[x,y,z], yaw }
  wakeUp: true,                  // ベッドで寝ている状態から起き上がる演出で開始
  clock: { h: 3, m: 0, rate: 0.05 },  // rate = 実時間1秒あたりのゲーム内分数
  ambience: 'room_tone',         // 省略可
  money: 1200,                   // 章開始時の所持金（省略で据え置き）
  gameOverReason: '冷蔵庫の中の顔と、目が合ってしまった。',
  setup(c) { /* 同期: インタラクト・ゾーン・顔・NPCの登録 */ },
  async intro(c) { /* 冒頭の演出（非同期） */ },
};
```

`setup` は章開始のたびに（リトライ時も）呼ばれる。世界の状態は章開始時に既定へリセットされる（扉は閉、照明は時間帯の既定、NPC 非表示、ポスターは既定、鍵: 玄関=施錠+チェーン有、電源=ON、冷蔵庫の懐中電灯ノード=非表示）。**章内の状態はフラグで管理し、setup でフラグを見て世界を組み直す**こと。

### 主なメソッド（すべて `src/game/Ctx.ts` 参照）

- 状態: `c.get(k)` `c.is(k)` `c.set(k, v=true)` `c.inc(k)` / `c.has(item)` `c.count(item)` `c.give(item, n?, silent?)` `c.take(item)` / `c.money` `c.addMoney(n)` / `c.battery`
- 台詞: `await c.say('なお', 'ごめん、こんな時間に')`（配列で複数ページ）/ `await c.mono('……つかない。')`（主人公の心の声。表示時に（）が付くので**本文に括弧を書かない**）/ `await c.narrate('…')`（中央のナレーション）
- 選択肢: `const i = await c.choice(['出る', '出ない'], '問い（省略可）')`（0始まり）
- 文書: `await c.doc('doc_id')`（`content/docs.ts`）。読むと自動で `read_<docId>` フラグが立つ
- UI: `c.objective('懐中電灯を探す' | null)` / `c.toast('…')` / `await c.card('二日目', '正午')` / `await c.fadeOut(1)` `await c.fadeIn(1)` / `await c.wait(秒)` / `await c.shop('conbini')`
- 世界: `c.prop(id)` → `Prop`（`.open(part?)` `.close(part?)` `.toggle()` `.isOpen(part?)` `.setOpen(t, part?)` `.showNode(name, bool)` `.visible=` `.position` `.toWorld([x,y,z])`）/ `c.light(id)` → `.setOn(bool)` `.setFlicker(bool)` `.level=0..1` / `c.anchor(id)` → Vector3 / `c.poster('poster_3', { tex:'poster_missing_3', visible:true })` / `c.lock(id, bool)` `c.isLocked(id)`（玄関: `'apt_door'` と チェーン `'apt_door_chain'`）/ `c.power(bool)`（部屋の照明回路）/ `c.time('day')` / `c.clock(h, m, rate)` / `c.tv('off'|'static'|'on')`
- インタラクト: `c.on(id, { label: () => '冷蔵庫を開ける' | null, use: async () => {...}, blind?: boolean, range?: number })` — 既定動作を上書き。`label` が null を返すとプロンプト非表示。`c.off(id)` で無効化、`c.reset(id)` で既定に戻す。**既定の機械的動作（扉の開閉・照明スイッチ等）を再利用**: `await c.useDefault(id)`。既定の一覧は `src/game/defaults.ts`
- トリガー: `c.zone('zone_corridor', { enter: async () => {...}, exit?, once?: true })` / `c.after(秒, fn)` / `c.every(秒, fn)` / `c.when(() => 条件, fn)`（1回）/ `c.onBlackout(fn)`（目を8秒閉じ続けた時。true を返すと既定処理を抑止）/ `c.run(async () => {...})`（並行スクリプト）
- 演出: `await c.cutscene(async () => {...})`（その間プレイヤー操作ロック）/ `await c.lookAt('anc_door_outside' | Vector3, 秒)` / `await c.wakeUp()` / `await c.lieDown()`（ベッドに横になって暗転）/ `c.shake(1)` / `c.flash('#fff', 0.5)` / `c.fear(0..1, 秒)` / `await c.peephole({ onEnter })`（ドアスコープ。プレイヤーが下がるまで待つ）/ `c.eyes(true)` で強制的に目を閉じる、`c.releaseEyes()` / `await c.blackoutTo('spawn_kitchen', { minutes: 20 })`（意識が落ちて別の場所で目覚める＝夢遊。時計も進む）/ `c.now` で現在の時計 {h, m} / `c.hint('[Space] 長押しで目を閉じる')`（左下の操作ヒント）
- 顔: `const f = c.face('anc_fridge_inside', { type: 'static'|'fleeting'|'approach'|'peek', lethal?: 2, scale?, harmless?, vanishAfter?, speed?, minDist?, style?: 'head'|'flat', onSeen?, onVanish? })` / `c.clearFace(f | 'anc_id')` / `c.clearFaces()` / `c.gaze`（0..1）/ `c.facesEnabled(bool)`
  - アンカーが小道具に属する場合（冷蔵庫の中など）、その小道具の本体は視線を遮らず、扉・ふたは遮る
  - 凝視判定: 画面中心約10°以内・遮蔽なし・目を開けている状態が `lethal` 秒（既定2秒）続くとゲームオーバー（お守り所持時は1回だけ肩代わり）。会話・選択肢の表示中は進まない。出現直後0.35秒は猶予
- NPC: `c.npc('npc_clerk', { at: 'npc_clerk_spot', label: '店員に話しかける', talk: async () => {...} })` / `c.hideNpc(id)`
- 音: `c.sfx('doorbell', { at: 'apt_door' | 'anc_x' | Vector3, volume?, rate?, delay? })` / `c.loop(id, { at? })` → handle（章終了で自動停止）/ `c.ambience('night_out' | null)`
- プレイヤー: `c.player.pos / .yaw / .eyesClosed / .flashlightOn` / `c.inZone(id)` / `c.teleport('spawn_x' | 'anc_x' | {pos, yaw})` / `c.flashlight({ owned?, on?, enabled? })` / `c.lockControls(bool)`
- 進行: `c.checkpoint('tag')`（章内チェックポイント。リトライ時 `c.checkpointTag === 'tag'` で setup に来る。intro はスキップされる）/ `await c.goto('ch2_day')`（次章へ。以降のコードは実行されない）/ `await c.ending('end_true')` / `c.gameOver('理由')`

**注意**: インタラクトの `use` が終わるまで他の物は調べられない（多重実行防止）。長い待ちや並行進行は `c.run(async () => …)` に逃がすこと。台詞・選択肢・文書は自動で順番待ちになるので、複数スクリプトから同時に呼んでも重ならない。

**注意**: `setup` の中で `await` しない（同期）。非同期の流れは `intro` か `c.run()` / イベントハンドラの中で書く。古い章の非同期処理は自動で中断される（`Aborted` 例外。握りつぶしてよい、catch しないこと）。

### シナリオ用に追加したAPI（docs/SCENARIO.md §7-A への対応）

- **A-1 寝たまま起きている**: `await c.lieAwake({ yaw: 70 })` → ベッドに横になり、視点だけ左右±yaw°・上下10〜85°で動く。移動不可・調べる不可・Space の閉眼と8秒ルール（`c.onBlackout`）は有効・顔の凝視判定も有効。`await c.getUp()` でベッド脇に立つ。`c.lying` で状態取得。横になったまま眠る（暗転）なら `await c.lieDown()`（lieAwake 中に呼ぶと目を閉じて暗転だけ）。
- **A-2 字幕**: `c.sub('なお', '……透くん、起きてる？', 3)` — 操作も閉眼も止めない字幕（画面下）。目を閉じている間の声は必ずこれ。
- **A-3 スマホの光**: `c.npc('npc_nao', { at: …, phoneGlow: true })` — 顔の下から冷たい白の小さな光で照らす（同時に1人まで）。
- **A-4 まぶた**: `c.lid(0..1)` で強制的にまぶたの開き具合を指定（0.5超は顔を見たことにならない）、`c.lid(null)` で解除。`c.eyes(true|false)` / `c.releaseEyes()` は「目を閉じる」状態の強制。
- **A-5 ゲームオーバー文の差し替え**: `c.gameOverReason = '……'`（その章の今回の挑戦の間だけ有効）。
- **A-6 開始地点・wakeUp をフラグで**: `spawn: (c) => c.is('x') ? 'spawn_kitchen' : 'spawn_bed'`, `wakeUp: (c) => !c.is('x')`
- **閉眼中の調べる**: 既定では `blind: true` を付けた物だけが「目を閉じたまま」調べられる（直前1.6秒以内に狙っていた物）。狙っていなくても閉眼中に出したい場合は `c.blindTarget('apt_fridge')`（null で解除）。覗き穴の中でも Space で目を閉じられる。
- 音: `c.sfx(id, { loop: false, ref, rolloff })` — ループ定義の音も1回だけ鳴らせる。`ref`(既定1.6m)/`rolloff`(既定1.0) で距離減衰を調整（部屋中に届かせるなら rolloff: 0.3 など）。常時鳴っている冷蔵庫などのうなりは `c.emitter('fridge_hum')?.setVolume(0)`。コンビニの自動ドアのチャイムは `c.autoDoorChime(false)` で止められる。`c.lookAt('npc_nao')` は NPC の頭を向く。
- ブレーカーのレバー: `c.breaker('sw_2', false)`（下げる）/ `c.breakerOn('sw_2')`。章開始時は全部ON。
- 夢遊での移動: `await c.blackoutTo('spawn_kitchen', { minutes: 20 })`

### シナリオ用に追加したノード／小道具（§7-B。すべて章開始時は非表示。`c.prop(id).showNode(name, true)` で出す）

| 小道具 | ノード |
|---|---|
| `apt_breaker` | `tape`（マスキングテープとメモ D01） |
| `apt_bathtub` | `water_full`（ふちまで張った水） |
| `apt_floor_water` | 小道具そのもの（浴室〜廊下〜洗濯機前の水たまり）。`c.prop('apt_floor_water').visible = true` |
| `apt_sink` | `towel`（鏡にかけたタオル）, `towel_floor`（床に落ちたタオル） |
| `apt_fridge` | `memo`（扉のメモ D02。扉と一緒に動く）, `flashlight_in_fridge`（棚の懐中電灯） |
| `apt_closet` | `tenbukuro_open`（天袋の板が外れた状態） |
| `apt_door` | `chain_hooked` / `chain_hanging`（チェーン。`c.lock('apt_door_chain', bool)` と合わせて切り替える） |
| `shr_hokora` | `ash`, `incense`（煙と火）, `hairpin`, `diary_offer` |

### ID対応（シナリオ表記 → 実装）
- apt_desk_drawer → `apt_desk`（引き出しパーツ `drawer`）／apt_bath_mirror → interact id `apt_bath_mirror`（実体 `apt_sink`）／apt_kitchen_drawer → interact id `apt_kitchen_drawer`（実体 `apt_kitchen_counter` の `drawer`）／apt_photo → interact id `apt_photo`（実体 `apt_bookshelf`）。apt_pc は使わない。
- 店: `c.shop('conbini')`（電池330・線香280・ミルクティー150）, `c.shop('vending')`（自販機。既定のインタラクトでも開く）, `c.shop('juyosho')`（授与所の面守り500円、章ごとに1つまで）
- 文書ID（content/docs.ts）: doc_memo_breaker, doc_memo_fridge, doc_line_nao, doc_receipt, doc_clinic_card, doc_notebook, doc_poster_shizuku, doc_yuisho, doc_ema, doc_song_half, doc_song_full, doc_call_log, doc_nao_note, doc_clinic_letter, doc_diary, doc_notice, doc_nao_phone
- アイテムID: flashlight, battery, omamori, incense, coffee, milktea, diary, hairpin, number_memo, coin10
- エンディングID: end1_ohayou, end2_omote, end3_nezunoban

### よく使うID

- 小道具/調べる対象: `src/world/layout.ts` の `prop('id', …)` と `interact:` を参照。例: `apt_fridge` `apt_door` `apt_breaker` `apt_switch_kitchen` `apt_switch_room` `apt_kitchen_drawer`(キッチンの引き出し。実体は `apt_kitchen_counter` の `drawer` パーツ) `apt_toilet` `apt_bath_mirror`(実体は `apt_sink`) `apt_bathtub` `apt_shower_curtain` `apt_bath_door` `apt_room_door` `apt_bed` `apt_desk` `apt_tv` `apt_lowtable` `apt_phone` `apt_closet` `apt_window` `apt_curtain` `apt_photo`(実体は `apt_bookshelf`) `apt_trash` `apt_calendar` `apt_ac` `apt_medicine` `apt_notebook` `apt_shoebox` `apt_washer` `apt_microwave` `ext_mailbox` `ext_vending` `ext_board` `ext_curve_mirror` `ext_garbage` `ext_phonebooth` `ext_barrier` `ext_door_101/102/104` `conbini_counter` `conbini_shelf` `conbini_fridge` `conbini_magazine` `conbini_atm` `shr_saisen` `shr_chozuya` `shr_ema` `shr_yuisho`(由緒書き) `shr_komainu` `shr_haiden` `shr_shinboku` `shr_hokora` `shr_kura`
- 照明: `apt_light_kitchen` `apt_light_room` `apt_light_bath` `apt_fridge_light` `apt_tv_light` `ext_corridor_light` `ext_vending_light` `conbini_in_1` `conbini_in_2` `conbini_out` `shrine_office_light` `phonebooth_light` `lamp_pole_n0..4` `lamp_pole_s0..4` `lamp_pole_e0..2`
- アンカー（顔の出現位置ほか）: `anc_fridge_inside` `anc_washer_inside` `anc_toilet_bowl` `anc_mirror` `anc_bathtub` `anc_under_bed` `anc_ceiling_bed` `anc_tv_screen` `anc_closet_gap` `anc_window_outside` `anc_room_corner` `anc_door_outside` `anc_kitchen_end` `anc_curve_mirror` `anc_street_far` `anc_board_behind` `anc_phonebooth` `anc_torii` `anc_haiden` `anc_shinboku` `anc_hokora` `anc_conbini_window` `anc_conbini_fridge` `anc_stairs`
- NPC 位置: `npc_clerk_spot` `npc_shrine_spot` `npc_neighbor_spot` `npc_nao_door` `npc_nao_genkan` `npc_nao_room`(座り) `npc_nao_bedside` `npc_extra_spot`。NPC ID: `npc_clerk` `npc_shrine` `npc_neighbor` `npc_nao` `npc_nao_sit` `npc_extra`
- ゾーン: `zone_apt` `zone_apt_genkan` `zone_apt_kitchen` `zone_apt_bath` `zone_apt_room` `zone_apt_balcony` `zone_corridor` `zone_apt_lot` `zone_street` `zone_side_street` `zone_board` `zone_vending` `zone_neighbor` `zone_phonebooth` `zone_conbini_lot` `zone_conbini_in` `zone_shrine` `zone_shrine_gate` `zone_haiden` `zone_shrine_office` `zone_shrine_back`
- スポーン: `spawn_bed` `spawn_genkan` `spawn_kitchen` `spawn_room` `spawn_corridor` `spawn_street` `spawn_conbini` `spawn_shrine` `spawn_hokora`
- ポスター: `poster_1`〜`poster_5`（掲示板）、`conbini_poster`、`shr_yuisho`
- 既定でエンジンが使うアイテムID: `flashlight`（懐中電灯。所持で F キー有効）, `battery`（電池切れ時に自動交換）, `omamori`（致死の凝視を1回肩代わり）

## Blender モデル規約（`src/world/catalog.json` の `_conventions` が正）

- `tools/blender/common.py` の関数は **three.js 座標**（x右, y上, z手前=正面）で書く: `box(name, (w,h,d), (x,y,z), mat(...))` `cyl(...)` `sphere(...)` `plane(...)` `mesh_from(...)` `set_origin(obj, (x,y,z))`（ピボット）`set_parent(child, parent)` `join([...], name)` `run_model('id', build)`
- 原点は足元中央（壁付けの物は catalog の指示どおり）。可動パーツはオブジェクト名を catalog の `parts` のキーと完全一致させ、原点をヒンジに置く。可動パーツの子にしたい細部は `set_parent` で親子付け。
- マテリアル名規約: `tex_*`（three側で画像を貼る。UV 0〜1）`emit_*`（発光。Emission を設定）`glass` `glass_frosted` `mirror` `water` `screen_*`
- 空洞が必要な物（冷蔵庫・洗濯機・トイレ・浴槽・クローゼット）は本当に中を空ける（顔が中に出る）。
- 確認: `npm run assets -- <name> --preview` → `tools/blender/previews/<id>.png` を Read で目視確認。`[model]` 行の size が catalog の size とほぼ一致すること。
