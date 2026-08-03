import type { AlignOp } from '../types';
import { phonetic } from '../lib/notation';
import { isNoise, UNSURE } from '../lib/align';

/**
 * 套印带 —— 这个工具的签名元素。
 *
 * 把音素级诊断画成一次双色凸版印刷的套准：黑版是标准音，蓝版是你刚发出来的音。
 *   套准（match）  两版完全重合，只见一个黑字
 *   滑开（sub）    蓝版错位停住，肉眼直接看见重影
 *   空槽（del）    只有黑版，字沉到空槽色、底下一道虚线
 *   孤字（ins）    一个没有黑底的孤立蓝字
 *
 * 四种结果全部从同一个隐喻里长出来，没有另外发明符号，也**没有红色**——
 * "套没套准"是工艺判断，"对/错"是评判（见 theme.ts 顶部）。
 *
 * **报出来的错**若模型自己拿不准，降成灰色虚线框：显示出来，但绝不冒充成确凿的错。
 * 范围只到错——match 恒为 sure（理由写在 app.ts 算 sure 那一段），所以对上的音不会
 * 出现"拿不准"这一档。虚线框也只挂在报错的格子上，跟这个范围是一致的
 * （styles.css 的 `.op-seg[data-unsure="1"]::before`）。
 *
 * 引选择器而不是行号：这里原先钉的是一个行号，而那一行早就变成了一个收尾的大括号——
 * 行号会被它上面任何一次改动推走，选择器不会，而且直接 grep 得到。
 * 有没有把握读 op.sure，这里不做判定（缘由见 server 的 espeak.ts CONFIDENT）。
 */

/**
 * 一格下面的小注。
 *
 * **只写日常说法。** 套印是这一版的视觉手法，"套准""滑开"这类印刷术语留在代码注释里
 * 解释设计意图就够了，不能跑到界面上当术语——第一版就是这么写的，结果没人看得懂。
 * 视觉隐喻要能不解释也成立，靠的是那道重影本身，不是给它起个名字。
 */
function tick(op: AlignOp, sure: boolean): string {
  // !sure 排在前面。服务端保证 match 恒为 sure（见 app.ts 算 sure 那一段），
  // 所以这一支对 match 到不了；这么排只是不想让"对"抢在"拿不准"前面——
  // 万一哪天 match 又能拿不准，默认行为该是如实说，而不是悄悄说"对"。
  if (!sure) return UNSURE;
  if (op.kind === 'match') return '对';
  // 直接把你发成了什么写出来。上面那个蓝字已经显示了，但配上一句话才不会有歧义
  if (op.kind === 'sub') return `发成了 ${phonetic(op.heardIpa)}`;
  if (op.kind === 'del') return '漏了';
  return '多了';
}

export default function OverprintStrip({ align }: { align: AlignOp[] }) {
  // 杂音不占格子。摆在那儿会被当成"可能发错了的一个音"，而它根本不是音——
  // 使用者反馈的正是这个：念了个 /k/，界面在它前面多列一个拿不准的 /t/。
  const noise = align.filter(isNoise).length;
  const shown = align.filter((op) => !isNoise(op));

  return (
    <div className="op">
      <span className="slug">黑色 标准音　蓝色 你发的音　重合就是发对了</span>
      <div className="op-seq">
        {shown.map((op, i) => {
          const sure = op.sure;
          // 黑版印目标音，蓝版印听到的音。del 没有蓝版，ins 没有黑版。
          const black = 'targetIpa' in op ? op.targetIpa : '';
          const blue = 'heardIpa' in op ? op.heardIpa : '';
          return (
            <div
              key={i}
              className="op-seg"
              data-state={op.kind}
              data-unsure={sure ? undefined : '1'}
            >
              <span className="op-glyph" data-blue={blue}>{black || blue}</span>
              {/* ── 标异常，不标常态 ──
                     发对的音原来也挂一个「对」，于是一个四音素的词全对时是「对 对 对 对」
                     一排。而"对"这件事**已经被说了三遍**：两版重合的黑字本身就是，
                     上面的图例刚讲过「重合就是发对了」，下面还有一句「每个音都发对了」。
                     标注重复到第四遍，唯一的作用是把真正有事的那一格淹掉。
                     视觉上拿掉，语义上留给屏幕阅读器——那边没有"看见重合"这回事。 */}
              <span className={op.kind === 'match' && sure ? 'op-tick sr-only' : 'op-tick'}>
                {tick(op, sure)}
              </span>
            </div>
          );
        })}
      </div>
      {/* 忽略掉了什么要说出来，不能悄悄扣掉——万一模型真听岔了，人得有迹可循 */}
      {noise > 0 && (
        <span className="op-tick" style={{ marginTop: 12 }}>
          另有 {noise} 处很短的声音没算进来，多半是气流或碰麦克风的杂音
        </span>
      )}
    </div>
  );
}
