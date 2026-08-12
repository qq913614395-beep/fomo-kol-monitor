# 真实只读 Fixture 清单

抓取时间：2026-08-04；GMGN CLI：`1.5.6`。授权范围仅为公开钱包与公开 RPC 的只读抓取。每个目录均包含独立 `metadata.json` 与 `expected.json`；原始响应不使用 expected 的整理结果反向生成。

## Nongwan / Solana

- 钱包：`498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ`
- 签名：`2gEh2GPZrhx4VjVe5DwvectM1jZr9UtBCg3BTqCWp3SDPuzPnpbPAA9mph9y58b47TpuPZzXhDwhgVczY5uhmt34`
- GMGN 页 1：`84d8e819f188ca7fb755ce5c92ffd0dbaf64941c924f1551d6f2476e3061469a`
- GMGN 页 2：`cdb3d81b20196c7c68715ee31fc343c98ea7d5faf521bd4ef1dbf4a7b3ee6a5e`
- GMGN 页 3：`62c0e8be4216991772f6e7c20fe575edd332b8edd60f67747e81a6a1e491a163`
- `getTransaction`：`74e6ec3bc97b69d9c4f44d05cc1134004f9f714818d24f3690e79b962c525ade`
- Golden：sell，2 legs，USD `2255.54482840545`（页面 `$2,255.54`），token amount `4747376.720885`。

## JACKET / BNB

- tx：`0x90002cf161e23bf3c7dcce5415b1d8b84cbb39057ca3063fd4252babf0f10023`
- GMGN：`0ada970fe525791a62a96dc23ccfa64569b988f4730fa11b2acf1d8fff46301e`
- transaction：`4e5eb2ee32f4cf994626ae36e3762953d718a8003921c9badefaaf5974de23a3`
- receipt：`1ad28891f54cac47c66e8052d491701ec8a9b727a30a7e1d200720c71d98a860`
- Golden：普通 `tx.from` 命中，terminal JACKET，NVDAB route-only，USD `1163.1332351698225`。

## FOLD / Base 与独立 UserOperation

- GMGN tx：`0x32eb9f5e22dabf5ed06f1e0f61dc8f2b44bbb238b596aa827b105ad175108686`
- UserOp tx：`0xc63807e9208429113fad88641e1d2adf9822476417c19781f1a25474ef27afa9`
- userOpHash：`0xd63d47eeeb74d91c943a8dce22f2920c714d4d6d6a6d3085b482a3656963fdc5`
- sender：`0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28`
- GMGN/transaction/receipt：`87dd3dd37fdecf08e1801424a392e5553b4013a6ecd1979d907a3b0e71aba605` / `3e7ba5a94cfddbec14a9a4e21256c3f6cf0345bcda5e3b55b053dac05f83e8ca` / `6d7703b093f5da7634fd62435a8362447d2516e310809a6497a3db09586703b8`
- UserOp transaction/receipt：`532309ae43aeffb188df8d7d1aa3a6b86e8c1ba362f5f5cb04e56e5dd2b4fb53` / `ed6f925932f8d7f06d65d9c81bbd6abcf9dbb272cc339d77f8ea5058aeffce72`
- 限制：两笔交易的直接关联未被原始证据证明，状态为 `blocked_unverified`；不得把它们伪造为同一交易。

## frankdegods / 精确钱包分页

- Solana 页 1–3 SHA-256 同 Nongwan 的三个原始 GMGN 页。
- BNB：`0ada970fe525791a62a96dc23ccfa64569b988f4730fa11b2acf1d8fff46301e`
- Base：`87dd3dd37fdecf08e1801424a392e5553b4013a6ecd1979d907a3b0e71aba605`
- Ethereum：`35081261c778e6c756342e783f1ee638d352d4ca32046a1d9059b651f2279b23`
- Golden：精确钱包身份、方向、资产、金额与跨页重复处理一致。

