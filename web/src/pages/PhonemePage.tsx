import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Link, useParams } from 'react-router';
import { Space, Spin, Tag, Typography } from 'antd';
import { api, isOffline } from '../api';
import type { PhonemeDetail } from '../types';
import { phonemic } from '../lib/notation';
import Notice from '../components/Notice';
import Offline from '../components/Offline';
import PageResult, { LoadFailed } from '../components/PageResult';
import DrillPhoneme from '../components/DrillPhoneme';

/**
 * 一个音素的文档页。
 *
 * **为什么要有它**：点音素 aɪ 弹出的是 dopamine 那篇笔记里
 * 「dopamine 的词尾 /miːn/」那一段，跟这个音毫无关系。根因是当时笔记只能靠
 * 音素 trigger 让自己出现，于是一篇讲词的笔记声明了 phoneme:aɪ，任何含 aɪ 的词都会命中它。
 *
 * 分工从此明确（articulation.ts 顶上也写着同一件事）：
 *   · **这一页**：这个音客观上怎么发——舌尖顶哪、气流走哪、唇形，跟谁在念无关。
 *     附上库里含这个音的例词，点过去能听、能看逐音素拆解。
 *   · **notes/**：这个人的问题。分两种范围——讲音的（triggers）会出现在这里，
 *     讲词的（words）只出现在那几个词的页面上，绝不因为某个词碰巧含这个音就冒出来。
 *
 * 所以这一页只列 triggers 命中的笔记。没有笔记是正常状态，不是缺陷：
 * 41 个音素都有「怎么发」，而笔记只在"你真的念差了很多"之后才写。
 */
/**
 * 只差重音的两对：模型不输出重音（espeak.ts 的 collapseStress），
 * 所以这两对之间**永远不报错**——音素页上得把这件事说出来，
 * 不然用户会奇怪"我明明把 about 的 ə 念成了 ʌ，怎么从来不报"。
 */
const STRESS_PAIR: Record<string, string> = { 'ə': 'ʌ', 'ʌ': 'ə', 'ɚ': 'ɝ', 'ɝ': 'ɚ' };

export default function PhonemePage() {
  const { ipa = '' } = useParams();
  useTitle(ipa && `/${ipa}/`);
  const [d, setD] = useState<PhonemeDetail | null>(null);
  // 「查无此音」和「服务没起来」原来共用一个 missing 标志，于是服务一停，
  // 这一页就说「没有这个音素：ə，音标里的符号一个都不能差」——**拿一句拼写指责
  // 去回答一次网络故障**，而他的音标一个字都没错。评测结果里点音标跳过来正好撞上。
  const [failed, setFailed] = useState<null | 'missing' | 'offline' | 'error'>(null);

  useEffect(() => {
    setD(null);
    setFailed(null);
    api.phoneme(ipa).then(setD).catch((e) => {
      setFailed(isOffline(e) ? 'offline' : e instanceof Error && /404/.test(e.message) ? 'missing' : 'error');
    });
  }, [ipa]);

  if (failed === 'offline') return <Offline />;
  if (failed === 'missing') {
    return (
      <PageResult slug="找不到" title={`没有这个音素：${ipa}`}>
        音标里的符号一个都不能差（IPA 的 ɡ 不是键盘上的 g）。去<Link to="/phonemes">音素表</Link>里挑。
      </PageResult>
    );
  }
  if (failed) {
    return (
      <LoadFailed what="这个音素" />
    );
  }
  if (!d) return <Spin style={{ marginTop: 48 }} />;

  const { phone, places, manners, examples, notes } = d;
  // place/manner 只存在于辅音那一支（元音有 height/back/rounded），所以要先收窄。
  // 直接读 phone.place 会被类型检查挡下来——这次就是这么挡下来的。
  const placeLabel = phone.kind === 'consonant'
    ? places.find((p) => p.id === phone.place)?.label
    : undefined;

  return (
    <div>
      <header className="word-head" style={{ marginBottom: 26 }}>
        <span className="reg-mark" aria-hidden="true"><i /></span>
        <div>
          <span className="slug">音素 · 这个音怎么发</span>
          <h1 className="display ipa" style={{ marginTop: 8 }}>{phonemic(phone.ipa)}</h1>
        </div>
      </header>

      <Space direction="vertical" size={26} style={{ width: '100%' }}>
        {/* 怎么发 —— 这一页的主体。落到可执行的身体动作上（articulation.ts 的 HOW_TO） */}
        {phone.howTo ? (
          <Typography.Text style={{ fontSize: 17, lineHeight: 1.9, maxWidth: '58ch', display: 'block' }}>
            {phone.howTo}
          </Typography.Text>
        ) : (
          // 41 个音素本该都有 howTo，缺了是数据漏填（articulation.ts 的 missingHowTo 会在
          // 启动时告警、测试会红）。这里如实说，别装作没这回事。
          <Notice tone="warn" label="数据缺口" title="这个音还没写「怎么发」">
            <code>server/src/analysis/articulation.ts</code> 的 HOW_TO 里缺这一条，补上就会显示。
          </Notice>
        )}

        {/* ── 这个音模型判得准吗 ──
               实测：辅音 41/42 对，
               元音只有 15/22、低元音 6/10，而且错法定向——被往 /æ/ 拽。
               所以只在元音页挂这条：报错先按上面的动作自检，别急着信模型。
               辅音页不挂——标异常不标常态。 */}
        {phone.kind === 'vowel' && (
          <Notice tone="quiet" label="模型判得准吗" title="元音的判定要打折听">
            <strong>说你这个音错了的时候，先照镜子按上面的动作自检一下。</strong>
            {'实测元音只判对 15/22，而辅音是 41/42，错法多半被拽向 /æ/。'}
            {'有真人录音的词不受影响——参考音跟你的录音过的是同一个模型，偏差两边抵消。'}
            {STRESS_PAIR[phone.ipa] && (
              <> 另外 {phonemic(phone.ipa)} 和 {phonemic(STRESS_PAIR[phone.ipa])} 只差重音，
              {'而模型听不出重音，这两个之间一律不判。'}</>
            )}
          </Notice>
        )}

        {/* 客观属性。只陈述，不推导——音系推导一律在服务端 */}
        <div>
          <span className="slug">发音部位</span>
          <div style={{ marginTop: 8 }}>
            <Space wrap size={8}>
              <Tag>{phone.kind === 'vowel' ? '元音' : '辅音'}</Tag>
              {placeLabel && <Tag>{placeLabel}</Tag>}
              {phone.kind === 'consonant' && manners[phone.manner] && <Tag>{manners[phone.manner]}</Tag>}
              {phone.kind === 'consonant' && <Tag>{phone.voiced ? '浊音（声带震）' : '清音（声带不震）'}</Tag>}
              {phone.kind === 'consonant' && phone.nasal && <Tag>鼻音（气流走鼻腔）</Tag>}
              {phone.kind === 'vowel' && <Tag>{phone.rounded ? '圆唇' : '不圆唇'}</Tag>}
              {phone.kind === 'vowel' && phone.glideTo && <Tag>双元音（口型在滑动）</Tag>}
            </Space>
          </div>
        </div>

        {/* 例词。**一块，不是两块**——"库里含这个音的词"和"挑一个练"渲染的是同一个
            examples 数组，分成两块的时候同样的词在一屏里叠了两遍（/n/ 有 9 个例词，
            上下两份一模一样）。现在词名是链接、旁边一个「练」就地展开录音器。 */}
        {examples.length > 0 ? (
          <DrillPhoneme ipa={phone.ipa} words={examples} />
        ) : (
          <div>
            <span className="slug">库里含这个音的词</span>
            <div style={{ marginTop: 10 }}>
              <Typography.Text type="secondary">
                库里还没有含这个音的词。在<Link to="/">首页</Link>查一个，它就会出现在这里。
              </Typography.Text>
            </div>
          </div>
        )}

        {/* 真正讲这个音的笔记。空着是正常的 —— 笔记只在"你真的念差了"之后才写 */}
        <div>
          <span className="slug">讲这个音的笔记</span>
          <div style={{ marginTop: 10 }}>
            {notes.length === 0 ? (
              <Typography.Text type="secondary" style={{ maxWidth: '58ch', display: 'block' }}>
                还没有。上面「怎么发」是这个音客观的发音方式，对所有人都一样；
                {'笔记是'}<strong>你自己</strong>在这个音上的问题，带自检法和对比训练——
                {'等你念到明显不对的时候，问一下 AI，它会写一篇。'}
              </Typography.Text>
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {notes.map((n) => (
                  <Link key={n.id} to={`/notes/${n.id}`}>{n.title}</Link>
                ))}
              </Space>
            )}
          </div>
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          <Link to="/phonemes">← 所有音素</Link>
        </Typography.Text>
      </Space>
    </div>
  );
}
