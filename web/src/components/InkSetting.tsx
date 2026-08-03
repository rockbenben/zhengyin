import { Card, Space, Typography } from 'antd';
import { useOutletContext } from 'react-router';
import type { InkContext } from '../layout';
import { DEFAULT_HUE, PRESETS, inkFor, type PaperPref } from '../lib/ink';

/**
 * 纸与墨：挑用哪套纸（浅色/深色/跟随系统），和第二版油墨的颜色。
 *
 * **纸这一档是补的。** 原来主题只跟随系统、没有开关，而这张卡的预览摆着
 * 「浅色纸/深色纸」两块样张，看着就像能挑——使用者当场问
 * 「浅色纸是浅色主题吗，怎么没地方切换」——预览本身造成的困惑：要么把预览收掉，
 * 要么把开关补上。补开关，因为那本来就是个真需求（系统在深色、但想在亮房间里
 * 用浅色纸看）。默认仍是跟随系统。
 *
 * 这套视觉是双色套印：黑版印标准音，第二版印你发的音。能换的**只有第二版**——
 * 黑版是标准音、红只给破坏性操作、琥珀是提醒，那三个是语义，换了会说错话。
 *
 * **只给备好的几款，没有自由取色器。** 这套视觉是印刷车间，车间里有墨屉不是调色仪；
 * 而且开放取色就得回答"挑了一版浅黄怎么办"——要么放任它糊在纸上，要么弹一堆警告
 * 教人怎么挑色，两条都比直接备好几款差。理由和加新墨的办法写在 lib/ink.ts。
 *
 * 预览用套印隐喻本身，不是几个色块：左边那格是套准的（黑版第二版重合，读作一个字），
 * 右边那格是滑开的（看得见重影）。你要判断的正是"滑开时好不好看、看不看得清"，
 * 那就直接把那个场景摆出来。深浅两套一起给——换墨的人多半只看得到自己那套。
 */
const PAPERS: Array<{ value: PaperPref; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色纸' },
  { value: 'dark', label: '深色纸' },
];

export default function InkSetting() {
  const { hue, setHue, dark, paper, setPaper } = useOutletContext<InkContext>();

  return (
    <Card title="纸与墨" size="small">
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          这套界面按双色套印排：<strong>黑版</strong>印标准音，<strong>第二版</strong>印你发的音。
          {'这里挑用哪套纸、第二版用什么颜色。'}
        </Typography.Text>

        {/* 纸的开关。摆在预览**上面**：下面那两块样张标着「浅色纸/深色纸」，
            看着就像能挑——原来确实不能，使用者当场问「怎么没地方切换」。 */}
        <div>
          <span className="slug">纸</span>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {PAPERS.map((p) => {
              const on = paper === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPaper(p.value)}
                  style={{
                    padding: '6px 12px', background: 'none', font: 'inherit', cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--black)' : 'var(--rule)'}`,
                    color: on ? 'var(--black)' : 'var(--quiet)',
                    fontWeight: on ? 600 : 400, fontSize: 13,
                  }}
                >
                  {p.label}
                  {p.value === 'system' && on && `（现在是${dark ? '深' : '浅'}色）`}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22 }}>
          {([['浅色纸', false, '#faf9f5', '#17161b'], ['深色纸', true, '#1a1917', '#eae7dd']] as const)
            .map(([label, isDark, paperBg, black]) => {
              const c = inkFor(hue, isDark);
              const current = isDark === dark;
              return (
                <div key={label}>
                  {/* 标出哪一块是你现在看着的那套——两块并排却不说，人会以为都在用 */}
                  <span className="slug" style={{ color: current ? 'var(--black)' : undefined }}>
                    {label}{current && ' · 当前'}
                  </span>
                  <div
                    style={{
                      marginTop: 6, display: 'flex', gap: 8, padding: '12px 14px',
                      background: paperBg,
                      border: `1px solid ${current ? 'var(--black)' : 'var(--rule)'}`,
                    }}
                  >
                    {/* 图注用**评测里的说法**，不用印刷术语。OverprintStrip 顶上那条约束
                        （"套准""滑开"这类词留在注释里、不能跑到界面上当术语，第一版这么写
                        没人看得懂）在这儿一样成立——而这两个词恰好就是它点名的那两个。
                        真正的套印带上写的是「重合就是发对了」，这里跟它对齐。 */}
                    <Sample paper={paperBg} black={black} ink={c.ink} soft={c.soft}
                      target="ʊ" heard="ʊ" caption="重合＝发对了" />
                    <Sample paper={paperBg} black={black} ink={c.ink} soft={c.soft}
                      target="ɑ" heard="æ" caption="错开＝发错了" />
                  </div>
                </div>
              );
            })}
        </div>

        <div>
          <span className="slug">墨屉 · 四款</span>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {PRESETS.map((p) => {
              const on = Math.round(hue) === p.hue;
              return (
                <button
                  key={p.name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setHue(p.hue)}
                  title={p.hue === DEFAULT_HUE ? `${p.name}（默认）` : p.name}
                  style={{
                    display: 'grid', justifyItems: 'center', gap: 5, cursor: 'pointer',
                    padding: '7px 9px', background: 'none', font: 'inherit',
                    border: `1px solid ${on ? 'var(--black)' : 'var(--rule)'}`,
                  }}
                >
                  {/* 色块按**当前这套纸**画。写死浅色的话，深色纸上看到的铜绿是
                      #005a40（近乎黑），而它在深色纸上其实是浅绿 #60bc97——
                      等于给了一个屏幕上根本不存在的颜色。实测截图才看出来。 */}
                  <span
                    aria-hidden="true"
                    style={{ width: 30, height: 13, background: inkFor(p.hue, dark).ink }}
                  />
                  <span
                    className="slug"
                    style={{
                      letterSpacing: '.06em',
                      color: on ? 'var(--black)' : undefined,
                      fontWeight: on ? 700 : 400,
                    }}
                  >
                    {p.name}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 「为什么没有红的橙的」是看到墨屉的人第一个会问的。不答一句，
            四款冷色看着像随便挑的；答了，它就成了这套配色的一条规则。 */}
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          屉里都是冷色：暖色那半圈已经被<span style={{ color: 'var(--amber)' }}>提醒</span>和
          <span style={{ color: 'var(--red)' }}> 清除</span>占着，第二版油墨落进去就跟它们撞了。
          {/* `localStorage` 这个词对用户没有意义，也没告诉他能做什么。
              他要知道的是：这个选择只在这台机器、这个浏览器里，换了就得重挑。 */}
          {'纸和墨只记在这台机器的这个浏览器里，不上传；换电脑、换浏览器都要重挑。'}
        </Typography.Text>
      </Space>
    </Card>
  );
}

/**
 * 一格套印样张。target===heard 时两版重合，读作一个正常的黑字；
 * 不同则第二版滑开，露出重影——这正是评测结果里那两种格子的画法。
 */
function Sample(
  { paper, black, ink, soft, target, heard, caption }:
  { paper: string; black: string; ink: string; soft: string;
    target: string; heard: string; caption: string },
) {
  const off = target !== heard;
  return (
    // 两格各配一个字。不配的话左边那格没有边框、只有一个孤零零的黑字，
    // 看着像排版漏了——而它恰恰是"套准了就只剩一个字"这件事本身。
    <span style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
      <span
        style={{
          position: 'relative', display: 'inline-grid', placeItems: 'center',
          minWidth: 46, padding: '9px 10px',
          border: `1px solid ${off ? ink : 'transparent'}`,
          background: off ? soft : paper,
        }}
      >
        <span className="ipa" style={{ fontSize: 21, color: black }}>{target}</span>
        {off && (
          <span
            className="ipa"
            aria-hidden="true"
            style={{
              position: 'absolute', left: '50%', top: '50%', fontSize: 21, color: ink,
              transform: 'translate(-38%, -44%)',
            }}
          >
            {heard}
          </span>
        )}
      </span>
      <span className="slug" style={{ letterSpacing: '.06em', color: off ? ink : black }}>
        {caption}
      </span>
    </span>
  );
}
