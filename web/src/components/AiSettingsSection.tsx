import { useEffect, useId, useRef, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Input, Radio, Select, Space, Spin, Tag, Typography, message,
} from 'antd';
import { api } from '../api';
import type {
  AiCliKind, AiEndpointRecord, AiMode, AiProtocol, AiSettings, AiStatusInfo, AiTestResult,
} from '../types';
import { AI_PRESETS, modelSuggestionsFor, visibleAiPresets, type AiPreset } from '../lib/aiPresets';

const CLI_LABELS: Record<AiCliKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  agy: 'Antigravity',
  custom: '自定义命令',
};

const PROTOCOL_LABELS: Record<AiProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

/** 超过这个数就先折叠——28 家平铺出来比选不出来更难受 */
const CHIP_LIMIT = 8;

const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return ''; }
};

/**
 * 设置页里的「AI 讲解」。
 *
 * 这一块负责四件事：选服务商、填地址/模型/密钥、切命令行、以及**把同意与否说清楚**。
 * 同意不是形式：勾上之后发音档案、相关笔记和这次的错误会被发到所选的服务，
 * 所以它单独一行、默认不勾，而且不勾时「测试连接」根本不会发请求。
 */
export default function AiSettingsSection() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [status, setStatus] = useState<AiStatusInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [showAll, setShowAll] = useState(false);
  const originalHosts = useRef<Record<string, string>>({});
  const modelListId = useId();

  useEffect(() => {
    Promise.all([api.aiSettings(), api.aiStatus()])
      .then(([s, st]) => {
        setSettings(s);
        setStatus(st);
        originalHosts.current = Object.fromEntries(
          Object.entries(s.endpoints).map(([k, v]) => [k, hostOf(v.baseUrl)]),
        );
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : '读取 AI 设置失败'));
  }, []);

  if (loadError) {
    return <Alert type="error" showIcon message="读取 AI 设置失败" description={loadError} />;
  }
  if (!settings || !status) return <Card><Spin /></Card>;

  const setMode = (mode: AiMode) => {
    setSettings((s) => (s ? { ...s, mode } : s));
    setErr(null);
    setTestResult(null);
  };

  const patchCli = (patch: Partial<AiSettings['cli']>) => {
    setSettings((s) => (s ? { ...s, cli: { ...s.cli, ...patch } } : s));
    setErr(null);
  };

  const patchActive = (patch: Partial<AiEndpointRecord>) => {
    setSettings((s) => {
      if (!s) return s;
      const cur = s.endpoints[s.endpointId];
      if (!cur) return s;
      return { ...s, endpoints: { ...s.endpoints, [s.endpointId]: { ...cur, ...patch } } };
    });
    setErr(null);
  };

  /** 切过去时保留各家自己的地址/模型/密钥；第一次点某家才按预置填一份。 */
  const selectProvider = (p: AiPreset) => {
    setSettings((s) => {
      if (!s) return s;
      if (s.endpoints[p.providerKey]) return { ...s, endpointId: p.providerKey };
      return {
        ...s,
        endpointId: p.providerKey,
        endpoints: {
          ...s.endpoints,
          [p.providerKey]: { protocol: p.protocol, baseUrl: p.base, key: '', model: p.model },
        },
      };
    });
    setErr(null);
    setTestResult(null);
  };

  const selectCustom = () => {
    setSettings((s) => {
      if (!s) return s;
      if (s.endpoints.custom) return { ...s, endpointId: 'custom' };
      return {
        ...s,
        endpointId: 'custom',
        endpoints: { ...s.endpoints, custom: { protocol: 'openai', baseUrl: '', key: '', model: '' } },
      };
    });
    setErr(null);
    setTestResult(null);
  };

  async function persist(): Promise<AiSettings> {
    if (!settings) throw new Error('还没加载完');
    const next = await api.saveAiSettings(settings);
    setSettings(next);
    originalHosts.current = Object.fromEntries(
      Object.entries(next.endpoints).map(([k, v]) => [k, hostOf(v.baseUrl)]),
    );
    setStatus(await api.aiStatus());
    return next;
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await persist();
      message.success('AI 设置已保存');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!settings) return;
    if (!settings.consent) {
      setErr('先勾选下面的同意项，再测试连接——不勾的话正音不会把任何资料发出去。');
      return;
    }
    setTesting(true);
    setErr(null);
    setTestResult(null);
    try {
      await persist();
      setTestResult(await api.aiTest());
    } catch (e) {
      setErr(e instanceof Error ? e.message : '连接失败');
    } finally {
      setTesting(false);
    }
  }

  const active = settings.endpoints[settings.endpointId];
  const preset = AI_PRESETS.find((p) => p.providerKey === settings.endpointId);
  const isCustom = settings.endpointId !== '' && !preset;
  const ready = Boolean(status?.configured && status.consent);

  const candidates = visibleAiPresets(showAll, active?.baseUrl);
  let chips = candidates;
  if (!showAll && candidates.length > CHIP_LIMIT) {
    chips = candidates.slice(0, CHIP_LIMIT);
    const current = candidates.find((p) => p.providerKey === settings.endpointId);
    if (current && !chips.includes(current)) chips = [...chips, current];
  }

  const originalHost = originalHosts.current[settings.endpointId];
  const hostMoved = Boolean(active?.key && originalHost && hostOf(active.baseUrl) !== originalHost);

  return (
    <Card
      title={
        <Space wrap>
          <span>选一个 AI 服务</span>
          {status && (
            <Tag color={ready ? 'success' : status.configured ? 'warning' : 'default'}>
              {ready ? '已就绪' : status.configured ? '还差同意' : '未配置'}
            </Tag>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" className="measure" style={{ marginBottom: 0 }}>
          配了之后，词条页能讲解「这个音为什么难」，也能把结论写成笔记。不配照样能用：
          查词、真人发音、逐音素评测和复习都在本机跑。
        </Typography.Paragraph>

        <Typography.Text type={ready ? 'success' : 'secondary'}>
          {ready
            ? `已就绪：${status.provider}`
            : status.configured
              ? `已经找到 ${status.provider}，但还没同意把它需要的资料发出去。`
              : `还差一步：${status.reason ?? '还没配好'}`}
        </Typography.Text>

        <Radio.Group value={settings.mode} onChange={(e) => setMode(e.target.value as AiMode)}>
          <Radio value="api">调接口</Radio>
          <Radio value="cli">用本机命令行</Radio>
        </Radio.Group>

        {status.mode !== settings.mode && (
          <Typography.Text type="warning" className="measure" style={{ fontSize: 13 }}>
            你切换了模式：上面的状态说的还是已经保存的那一套，按「保存」之后才生效。
          </Typography.Text>
        )}

        {settings.mode === 'api' ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Typography.Text strong>服务商</Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {chips.map((p) => (
                  <Button
                    key={p.providerKey}
                    size="small"
                    aria-pressed={settings.endpointId === p.providerKey}
                    onClick={() => selectProvider(p)}
                  >
                    {p.label}
                  </Button>
                ))}
                <Button
                  size="small"
                  aria-pressed={isCustom}
                  onClick={selectCustom}
                >
                  自定义
                </Button>
                {candidates.length > CHIP_LIMIT && (
                  <Button type="link" size="small" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? '收起' : '更多厂商'}
                  </Button>
                )}
              </div>
            </div>

            {!active ? (
              <Alert type="info" showIcon message="先选一家服务商；都不合适就点「自定义」，自己填地址。" />
            ) : (
              <>
                {isCustom && (
                  <div>
                    <Typography.Text strong>协议</Typography.Text>
                    <div style={{ marginTop: 8 }}>
                      <Select
                        aria-label="协议"
                        value={active.protocol}
                        style={{ minWidth: 200 }}
                        onChange={(v) => patchActive({ protocol: v as AiProtocol })}
                        options={Object.entries(PROTOCOL_LABELS).map(([value, label]) => ({ value, label }))}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <Typography.Text strong>接口地址</Typography.Text>
                  <Input
                    aria-label="接口地址"
                    value={active.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(e) => patchActive({ baseUrl: e.target.value })}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    填到版本路径就行（如 https://api.openai.com/v1）；填完整的 /chat/completions 也认。
                  </Typography.Text>
                </div>

                <div>
                  <Typography.Text strong>模型</Typography.Text>
                  <Input
                    aria-label="模型"
                    list={modelListId}
                    value={active.model}
                    placeholder={preset ? '从下面的候选里选，或自己填' : '模型名，如 gpt-6-luna'}
                    onChange={(e) => patchActive({ model: e.target.value })}
                  />
                  <datalist id={modelListId}>
                    {modelSuggestionsFor(preset).map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>

                <div>
                  <Typography.Text strong>密钥</Typography.Text>
                  {/* 普通输入框，不是密码框：服务端只回打码后的值，用密码框会把它整串
                      变成圆点，反而看不到「末四位」——而那句话就写在下面。 */}
                  <Input
                    aria-label="密钥"
                    value={active.key}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="粘贴 API key"
                    onChange={(e) => patchActive({ key: e.target.value })}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    只显示末四位；不动它就保留原来那把。密钥只存在这台机器上。
                  </Typography.Text>
                </div>

                {hostMoved && (
                  <Alert
                    type="warning"
                    showIcon
                    message="接口地址的主机名变了"
                    description="保存时服务端会清空原来的密钥，避免把旧服务商的 key 发到新地址；需要重填一次。"
                  />
                )}
              </>
            )}
          </Space>
        ) : (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Typography.Text strong>命令行工具</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Select
                  aria-label="命令行工具"
                  value={settings.cli.kind}
                  style={{ minWidth: 200 }}
                  onChange={(v) => patchCli({ kind: v as AiCliKind })}
                  options={Object.entries(CLI_LABELS).map(([value, label]) => ({ value, label }))}
                />
              </div>
            </div>

            <div>
              <Typography.Text strong>可执行文件路径</Typography.Text>
              <Input
                aria-label="命令行路径"
                value={settings.cli.path}
                placeholder="留空就用 PATH 上的那个"
                onChange={(e) => patchCli({ path: e.target.value })}
              />
            </div>

            {settings.cli.kind === 'custom' && (
              <div>
                <Typography.Text strong>参数</Typography.Text>
                <Input.TextArea
                  aria-label="自定义参数"
                  value={settings.cli.customArgs}
                  rows={2}
                  placeholder="用 {prompt} 表示提示词要放的位置；不写就追加在最后"
                  onChange={(e) => patchCli({ customArgs: e.target.value })}
                />
              </div>
            )}

            <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
              走的是本机已经装好、已经登录的工具；正音只把提示词交给它，不保存你的登录凭证。
            </Typography.Text>
          </Space>
        )}

        <Checkbox
          checked={settings.consent}
          onChange={(e) => setSettings((s) => (s ? { ...s, consent: e.target.checked } : s))}
        >
          我同意把发音档案、相关笔记和这次的错误发给我选的 AI 服务
        </Checkbox>

        <Space wrap>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
          <Button loading={testing} onClick={() => void test()}>
            测试连接
          </Button>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          改完按「保存」生效；「测试连接」会先保存再测。
        </Typography.Text>

        {err && <Alert type="error" showIcon message={err} />}
        {testResult?.ok && (
          <Alert
            type="success"
            showIcon
            message={`连接成功（${testResult.latencyMs ?? 0} ms）· ${testResult.provider ?? ''}`}
            description={testResult.sample ? `它回了一句：${testResult.sample}` : undefined}
          />
        )}
      </Space>
    </Card>
  );
}
