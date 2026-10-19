/// 按行 diff（R-DC-03：历史版本和当前版本对比，前端计算）。
library;

enum DiffOp { same, added, removed }

class DiffLine {
  final DiffOp op;
  final String text;
  const DiffLine(this.op, this.text);
  @override
  String toString() => '${op.name}:$text';
}

/// 计算从 [oldText] 到 [newText] 的行级差异（LCS）。过大时退化为整段替换。
List<DiffLine> diffLines(String oldText, String newText) {
  final a = oldText.replaceAll('\r\n', '\n').split('\n');
  final b = newText.replaceAll('\r\n', '\n').split('\n');
  // 去掉公共前后缀，减少 DP 规模
  var pre = 0;
  while (pre < a.length && pre < b.length && a[pre] == b[pre]) {
    pre++;
  }
  var suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] == b[b.length - 1 - suf]) {
    suf++;
  }
  final out = <DiffLine>[for (var i = 0; i < pre; i++) DiffLine(DiffOp.same, a[i])];
  final x = a.sublist(pre, a.length - suf), y = b.sublist(pre, b.length - suf);
  if (x.length * y.length > 4000000) {
    out
      ..addAll(x.map((l) => DiffLine(DiffOp.removed, l)))
      ..addAll(y.map((l) => DiffLine(DiffOp.added, l)));
  } else {
    final n = x.length, m = y.length;
    final dp = List.generate(n + 1, (_) => List<int>.filled(m + 1, 0));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = x[i] == y[j] ? dp[i + 1][j + 1] + 1 : (dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1]);
      }
    }
    var i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] == y[j]) {
        out.add(DiffLine(DiffOp.same, x[i]));
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.add(DiffLine(DiffOp.removed, x[i++]));
      } else {
        out.add(DiffLine(DiffOp.added, y[j++]));
      }
    }
    while (i < n) {
      out.add(DiffLine(DiffOp.removed, x[i++]));
    }
    while (j < m) {
      out.add(DiffLine(DiffOp.added, y[j++]));
    }
  }
  for (var i = a.length - suf; i < a.length; i++) {
    out.add(DiffLine(DiffOp.same, a[i]));
  }
  return out;
}

/// 新增 / 删除的字数（用于版本列表的「改了多少字」兜底）。
({int added, int removed}) diffStat(List<DiffLine> d) {
  var add = 0, rm = 0;
  for (final l in d) {
    if (l.op == DiffOp.added) add += l.text.length;
    if (l.op == DiffOp.removed) rm += l.text.length;
  }
  return (added: add, removed: rm);
}
