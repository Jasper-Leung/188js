/**
 * GDScript 字面量解析器 —— 用来从 Godot 源项目里**机械地**搬数据。
 *
 * 为什么要有它：road_data.gd / shop_data.gd / Localization.gd 里是几百条文案和
 * 上百个数值。手抄一次就是一个 typo，而 typo 在这类数据里几乎不可见——
 * 驿站名错一个字、碎片颜色偏一个通道，玩起来"就是有点怪"，回归还是绿的。
 * 所以这里写一个只认字面量的解析器，把它们原样搬成 JSON，一个字符都不改。
 *
 * 它只解析数据（dict / array / 标量 / Vector2 / Color / 常量引用），
 * 遇到函数调用或表达式就报错退出——宁可失败也不能猜。
 */

export class GdParseError extends Error {
  constructor(message, path, src, pos) {
    const { line, col } = lineCol(src, pos);
    super(`${path}:${line}:${col}  ${message}`);
    this.name = 'GdParseError';
  }
}

/** 字节下标 → 行列。传的是**源码**而不是路径——传错的话每条错误都报 1:1。 */
function lineCol(src, pos) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_]/;

/** 词法分析：把 GDScript 源码切成 token 流 */
function tokenize(src, file) {
  const tokens = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // 空白
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    // 续行符：GDScript 用行尾反斜杠接下一行（road_data.gd 的 _canvas_tangent 就是）
    if (c === '\\') {
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j++;
      if (src[j] === '\n') {
        i = j + 1;
        continue;
      }
      throw new GdParseError('孤立的反斜杠', file, src, i);
    }

    // 注释：# 到行尾（不在字符串里的 # 一定是注释）
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // 字符串：双引号（源项目里文案全用双引号）
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let value = '';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          const esc = src[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === "'") value += "'";
          else if (esc === 'u') {
            // \uXXXX
            const hex = src.slice(i + 2, i + 6);
            value += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          } else value += esc;
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (i >= n) throw new GdParseError('字符串没有闭合', file, src, start);
      i++; // 吃掉收尾引号
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }

    // 数字
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < n && /[0-9]/.test(src[i])) i++;
      let isFloat = false;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        isFloat = true;
        i++;
        while (i < n && /[0-9]/.test(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        isFloat = true;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        while (i < n && /[0-9]/.test(src[i])) i++;
      }
      const text = src.slice(start, i);
      tokens.push({ type: 'number', value: isFloat ? parseFloat(text) : parseInt(text, 10), pos: start });
      continue;
    }

    // 标识符 / 关键字
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT.test(src[i])) i++;
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }

    // 符号
    const two = src.slice(i, i + 2);
    if (two === '->' || two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      tokens.push({ type: 'punct', value: two, pos: i });
      i += 2;
      continue;
    }
    // 单字符符号。取模 `%` 一定要在：road_data.gd 的函数体里到处是
    // `(lm_idx + 1) % n`，而这个文件恰好是我们第一个要搬的数据源。
    if ('{}[](),:.-+*/%<>=!&|~^@?;$'.includes(c)) {
      tokens.push({ type: 'punct', value: c, pos: i });
      i++;
      continue;
    }

    throw new GdParseError(`无法识别的字符 ${JSON.stringify(c)}`, file, src, i);
  }

  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}

const CONST_VECTORS = {
  'Vector2.ZERO': [0, 0],
  'Vector2.ONE': [1, 1],
  'Vector2.UP': [0, 1],
  'Vector2.RIGHT': [1, 0],
  'Vector2.LEFT': [-1, 0],
  'Vector2.DOWN': [0, -1],
  'Vector3.ZERO': [0, 0, 0],
  'Vector3.ONE': [1, 1, 1],
  'Vector3.UP': [0, 1, 0],
  'Vector3.DOWN': [0, -1, 0],
  'Vector3.RIGHT': [1, 0, 0],
  'Vector3.LEFT': [-1, 0, 0],
  'Vector3.FORWARD': [0, 0, -1],
  'Vector3.BACK': [0, 0, 1],
};

/** 递归下降解析 token 流 */
class Parser {
  constructor(tokens, file, src) {
    this.t = tokens;
    this.i = 0;
    this.file = file;
    this.src = src;
  }

  peek(offset = 0) {
    return this.t[this.i + offset];
  }

  next() {
    return this.t[this.i++];
  }

  expect(value) {
    const tok = this.next();
    if (tok.value !== value) {
      throw new GdParseError(
        `期望 ${JSON.stringify(value)}，实际是 ${JSON.stringify(tok.value)}`,
        this.file,
        this.src,
        tok.pos,
      );
    }
    return tok;
  }

  parseValue() {
    const tok = this.peek();

    if (tok.type === 'string') {
      this.next();
      return tok.value;
    }
    if (tok.type === 'number') {
      this.next();
      return tok.value;
    }
    if (tok.type === 'ident') {
      return this.parseIdentValue();
    }
    if (tok.value === '{') return this.parseDict();
    if (tok.value === '[') return this.parseArray();
    if (tok.value === '-') {
      this.next();
      const inner = this.parseValue();
      if (typeof inner !== 'number') {
        throw new GdParseError('负号后面不是数字', this.file, this.src, tok.pos);
      }
      return -inner;
    }
    throw new GdParseError(`无法解析的值（token=${tok.type}:${JSON.stringify(tok.value)}）`, this.file, this.src, tok.pos);
  }

  parseIdentValue() {
    const tok = this.next();
    const name = tok.value;

    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    if (name === 'inf' || name === 'INF') return Infinity;
    if (name === 'nan' || name === 'NAN') return NaN;

    // Color / Vector2 / Vector3 / Vector2i 的常量：Color(1,1,1,1) 走这里
    if (name === 'Color' || name === 'Vector2' || name === 'Vector3' || name === 'Vector2i') {
      return this.parseCall(name, tok.pos);
    }

    // 带点号的常量：Vector2.ZERO / Vector3.UP
    if (this.peek().value === '.') {
      this.next();
      const prop = this.next();
      const full = `${name}.${prop.value}`;
      if (full in CONST_VECTORS) return { __const: full, value: CONST_VECTORS[full] };
      // 枚举值或别的常量引用，交给调用方解析
      return { __ref: full };
    }

    // 裸标识符：可能引用另一个常量
    return { __ref: name };
  }

  parseCall(name, pos) {
    this.expect('(');
    const args = [];
    if (this.peek().value !== ')') {
      for (;;) {
        args.push(this.parseValue());
        if (this.peek().value === ',') {
          this.next();
          if (this.peek().value === ')') break; // 尾随逗号
          continue;
        }
        break;
      }
    }
    this.expect(')');

    if (name === 'Color') {
      if (args.length < 3) throw new GdParseError(`Color 参数不足：${args.length}`, this.file, this.src, pos);
      const [r, g, b, a = 1] = args;
      return { __color: [r, g, b, a] };
    }
    if (name === 'Vector2' || name === 'Vector2i') {
      if (args.length < 2) throw new GdParseError('Vector2 参数不足', this.file, this.src, pos);
      return { __v2: [args[0], args[1]] };
    }
    if (name === 'Vector3') {
      if (args.length < 3) throw new GdParseError('Vector3 参数不足', this.file, this.src, pos);
      return { __v3: [args[0], args[1], args[2]] };
    }
    throw new GdParseError(`不认识的构造调用 ${name}`, this.file, this.src, pos);
  }

  parseArray() {
    this.expect('[');
    const out = [];
    while (this.peek().value !== ']') {
      out.push(this.parseValue());
      if (this.peek().value === ',') {
        this.next();
        continue;
      }
      break;
    }
    this.expect(']');
    return out;
  }

  parseDict() {
    this.expect('{');
    const out = {};
    while (this.peek().value !== '}') {
      const keyTok = this.peek();
      let key;
      if (keyTok.type === 'string' || keyTok.type === 'ident') {
        this.next();
        key = keyTok.value;
      } else if (keyTok.type === 'number') {
        // 数字键：FRAGMENT_STATION_TO_SLOT / SHOP_AT_STATION 都是 {7: 0, 10: 1} 这种。
        // JS 的对象键本来就是字符串，这里统一成字符串，不丢信息。
        this.next();
        key = String(keyTok.value);
      } else {
        throw new GdParseError(`字典键不是字符串：${JSON.stringify(keyTok.value)}`, this.file, this.src, keyTok.pos);
      }
      this.expect(':');
      out[key] = this.parseValue();
      if (this.peek().value === ',') {
        this.next();
        continue;
      }
      break;
    }
    this.expect('}');
    return out;
  }
}

/** 解析一整份 GDScript 里某个具名的顶层常量 / 变量字面量。 */
export function extractLiteral(src, file, name) {
  const tokens = tokenize(src, file);
  const p = new Parser(tokens, file, src);

  for (let i = 1; i < tokens.length - 2; i++) {
    const t = tokens[i];
    if (t.type !== 'ident' || t.value !== name) continue;

    // 必须**紧跟在 const / var 后面**。
    // 只按名字找是不行的：同名标识符会先在函数签名或调用点命中，
    // 搬回来的是一句调用而不是那张表——而且它不报错，只是数据全错。
    const decl = tokens[i - 1];
    if (decl.type !== 'ident' || (decl.value !== 'const' && decl.value !== 'var')) continue;

    // 跳掉类型标注：`: Array` / `: Array[Vector2]` / `: Dictionary` / `: float`
    let j = i + 1;
    while (j < tokens.length - 1) {
      const tj = tokens[j];
      if (tj.value === ':' || tj.value === '[' || tj.value === ']') {
        j++;
        continue;
      }
      if (tj.type === 'ident' && tj.value !== 'const' && tj.value !== 'var') {
        j++;
        continue;
      }
      break;
    }
    if (tokens[j].value !== '=') continue;

    p.i = j + 1;
    return p.parseValue();
  }

  throw new Error(`${file}: 找不到常量 ${name}`);
}

/** 把 __ref 换成已知的顶层常量，做一次依赖展开。 */
export function resolveRefs(value, consts, seen = new Set()) {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, consts, seen));
  if (value && typeof value === 'object') {
    if (value.__ref) {
      const refName = value.__ref;
      if (seen.has(refName)) {
        throw new Error(`常量循环引用：${[...seen].join(' -> ')} -> ${refName}`);
      }
      if (!(refName in consts)) {
        throw new Error(`未定义的常量引用：${refName}`);
      }
      seen.add(refName);
      const resolved = resolveRefs(consts[refName], consts, seen);
      seen.delete(refName);
      return resolved;
    }
    if (value.__const) return value.value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, consts, seen);
    return out;
  }
  return value;
}
