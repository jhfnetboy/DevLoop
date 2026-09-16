# 外部文档源接口契约（飞书 / Notion）

需求、设计、验收标准常常**不在仓库里** —— 在飞书云文档或 Notion 页面上。这份契约说明
pilot 怎么用它们，以及**不做什么**。

## pilot 是入口,配套能力由它安排

**pilot 是唯一入口 skill;飞书、Notion 这些文档源是它的配套。** 该不该装、装哪一个、
装到全局还是项目级、装完怎么验证 —— 由 pilot 安排。用户不该被要求自己记住几十个 skill 谁是谁,
也不该自己去判断这台机器缺什么。

**但「入口」是编排责任,不是运行时依赖。** pilot 自己**不 import、不启动、不封装**任何文档源:
它只在需要时**探测**能力是否存在,有就用,没有就如实说明缺什么、给出装法,并降级继续干活。

> 这条界线不是洁癖。pilot 会装到很多仓库、很多机器上;把飞书/Notion 的具体调用写进 pilot,
> 等于让每一台没配 token 的机器都带着一个坏掉的依赖 —— 就是 pr-daemon 那次耦合,
> 花了 6 轮评审才拆干净。**「pilot 是入口」不是把硬依赖写回去的理由。**
> 同一个原则见 [`review-contract.md`](review-contract.md)。

实际使用时,用户自然说一句「读一下这篇飞书文档」,harness 可能直接命中 `lark-doc` 而不经过 pilot ——
**这不违反入口约定**。约定管的是「能力从哪来、谁负责装、谁负责讲清楚」,不是每一次调用都必须过 pilot。

## 探测(机械的,不要凭印象)

**探测分三层,逐层往下,任一层不过就停在那一层并报出缺的是哪一层。**
不要自己发明判据 —— 同一件事两处各写一套判法然后分叉,是这个仓库反复栽过的坑。

| 层 | 飞书 | Notion |
|:---|:---|:---|
| **① 能力装了没** | `command -v lark-cli` 退出码 0 | 该 skill 的 `scripts/notion.py` 存在 |
| **② 凭证有没有** | `lark-cli auth status --json --verify` 的 `identities.user.status == "ready"` | `GET /v1/users/me` 返回 200 |
| **③ 目标读不读得到** | `lark-cli docs +fetch --doc <token> --as user` 返回 `ok: true` | `GET /v1/pages/<id>` 返回 200 |

**三层缺一不可,而且失败在哪一层决定了怎么补**:① 缺 → 去装(见下节);② 缺 → 让用户授权;
③ 缺 → 权限没覆盖到那个具体文档/页面,只能人去开。把这三种笼统报成「读不到」,用户没法行动。

**第 ② 层的关键**:飞书 `identity` 显示 `bot` **不代表**能读你的文档。bot 身份只能看
「共享给这个应用的东西」,**读用户自己的云文档必须 user 身份**。
只看 `ok: true` 或 `bot: ready` 就当作可用,是这份契约里最容易犯的错。

**第 ③ 层不能省。** 前两层全绿仍然可能读不到目标 —— 而且这一层是唯一的权威判据,
详见下面「列表 API 不是可读清单」。

飞书那条的**关键**:`identity` 显示 `bot` 不代表能读你的文档。bot 身份只能看
「共享给这个应用的东西」,**读用户自己的云文档必须 user 身份**。
只看 `ok: true` 或 `bot: ready` 就当作可用,是这份契约里最容易犯的错。

user 身份缺失时的补法(要用户在浏览器里点):

```bash
# 阻塞式,放后台跑,把输出里的 verification_url 交给用户。它自己轮询,用户点完当场完成。
lark-cli auth login --domain docs,drive,wiki
```

⚠️ **不要用 `--no-wait` + `--device-code` 两段式。** device code 只有 10 分钟,而
「发链接 → 用户去授权 → 用户回来告诉你 → 你再去换 token」这个来回本身就会超时 ——
实测连续失败两次,换成阻塞式一次就成。详见下节安装部分。

Notion 的对应坑:token 有效 **≠** 能看到目标页面。integration 只能看到被 connect 的页面 ——
但**后代会继承**:在入口页(workspace 顶层那一页)上连一次,底下所有子页面都可读。
实测:单个 connection 加在入口页,4 层深的孙子页照样读得到。所以正确的补法是
**在入口页连一次**,而不是逐页 share;这一步只能人在 Notion UI 里做(`···` → Connections)。

**不要用 `/v1/search` 判断可见范围。** 它有索引延迟(同一 token 在加 connection 前后
分别返回 8 条和 100+ 条),而且单页上限 100 条 —— 搜不到不等于读不到。要确认某页能否读,
**直接去读它**(`GET /v1/pages/<id>` 或递归遍历 children),那才是权威判据。

## 列表 API 不是可读清单(两个平台都是)

**「列不出来」不等于「读不到」。** 这条踩过两次,方向相反但根因相同:列表接口反映的是
*索引/成员关系*,不是*访问权限*。拿列表当清单,会得出「这个账号是空的」这种错误结论。

- **飞书**:`wiki spaces list` **不返回个人文档库**(`space_type: my_library`),
  `drive files list` 对根目录返回 0 —— 但同一时刻,个人库里的文档 `docs +fetch` 全部读得到。
- **Notion**:`/v1/search` 有索引延迟且单页上限 100 —— 同一个 token,加 connection 前后
  分别返回 8 条和 100+ 条。

**可靠的做法:从一个已知的文档链接反查容器,再遍历容器。**

```bash
# 飞书:doc URL/token → 它所在的空间 → 该空间全部节点
lark-cli wiki spaces get_node --token <node_token> --json     # → space_id
lark-cli wiki nodes list --space-id <space_id> --json
lark-cli docs +fetch --doc <token> --doc-format markdown --as user
```

```bash
# Notion:入口页 → 递归子页面(search 只作发现用途)
notion.py tree <入口页> --depth N
notion.py read <page>
```

要判断某个文档能不能读,**直接去读它**,那才是权威判据。

## pilot 侧只读

`plan` / `run` 从这些源**只读取**,绝不写回。需求文档是人在维护的事实来源,
agent 往里写等于在没人看着的时候改需求。产出要发出去,是**另一件事**,由用户显式发起。

## 没装的时候怎么装(这是 pilot 的职责)

探测失败不是终点 —— pilot 要能说清楚**缺哪一步、这一步怎么补**。以下都是实测过的:

```bash
# 飞书:CLI → 配套 skill → 建应用 → 用户身份授权
npm install -g @larksuite/cli
npx -y skills add https://open.feishu.cn -g --skill lark-doc -y   # 再依次 lark-drive/lark-wiki/lark-shared
lark-cli config init --new                        # 建应用;阻塞,后台跑并把 URL 交给用户
lark-cli auth login --domain docs,drive,wiki      # 用户身份;同样阻塞自轮询
```

三个坑,不避开就装不上:

- **`-g` 必须显式给**。不给的话 `skills` CLI 按 cwd 自动判断,在仓库里跑就装成项目级了。
- **一次只能装一个 skill**。逗号分隔无效;官方文档里的 `--skill -y` 会把 `-y` 当成 skill 名,
  结果只列不装。
- **授权用阻塞式,不要 `--no-wait`**。device code 只有 10 分钟,而「发链接 → 用户授权 → 用户回话 →
  再去换 token」这个来回本身就会超时(实测连续失败两次)。阻塞式自己轮询,用户点完当场就成。

```bash
# Notion:装全局 + 认 token + 认入口页
bash <notion-publish skill>/install.sh --global
# token 走 $JHF_NOTION_TOKEN;入口页写在该 skill 的 config.json 的 default_parent
```

Notion 侧要人工做的只有一件:**在入口页加一次 connection**(`···` → Connections),后代自动继承。

## 拿不到的时候(降级路径)

按顺序,不要停在第一步:

1. **探测失败** → 如实说明缺什么(是没装 CLI、还是 user 身份没授权、还是页面没 share),
   把补齐的命令给出来;
2. **不阻塞** → 请用户把文档内容直接贴进对话,或指一个仓库内的等价文件,照常开工;
3. **绝不猜内容。** 没读到就是没读到 —— 编一份需求文档出来,比没有需求文档危险得多。

> 完全没有外部文档源的仓库是**正常情况**(需求本来就写在 `docs/` 里)。
> 这时这份契约不适用,直接读仓库里的规划文档即可。
