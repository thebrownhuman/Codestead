var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/postgres-array/index.js
var require_postgres_array = __commonJS({
  "node_modules/postgres-array/index.js"(exports) {
    "use strict";
    exports.parse = function(source, transform) {
      return new ArrayParser(source, transform).parse();
    };
    var ArrayParser = class _ArrayParser {
      constructor(source, transform) {
        this.source = source;
        this.transform = transform || identity;
        this.position = 0;
        this.entries = [];
        this.recorded = [];
        this.dimension = 0;
      }
      isEof() {
        return this.position >= this.source.length;
      }
      nextCharacter() {
        var character = this.source[this.position++];
        if (character === "\\") {
          return {
            value: this.source[this.position++],
            escaped: true
          };
        }
        return {
          value: character,
          escaped: false
        };
      }
      record(character) {
        this.recorded.push(character);
      }
      newEntry(includeEmpty) {
        var entry;
        if (this.recorded.length > 0 || includeEmpty) {
          entry = this.recorded.join("");
          if (entry === "NULL" && !includeEmpty) {
            entry = null;
          }
          if (entry !== null) entry = this.transform(entry);
          this.entries.push(entry);
          this.recorded = [];
        }
      }
      consumeDimensions() {
        if (this.source[0] === "[") {
          while (!this.isEof()) {
            var char = this.nextCharacter();
            if (char.value === "=") break;
          }
        }
      }
      parse(nested) {
        var character, parser, quote;
        this.consumeDimensions();
        while (!this.isEof()) {
          character = this.nextCharacter();
          if (character.value === "{" && !quote) {
            this.dimension++;
            if (this.dimension > 1) {
              parser = new _ArrayParser(this.source.substr(this.position - 1), this.transform);
              this.entries.push(parser.parse(true));
              this.position += parser.position - 2;
            }
          } else if (character.value === "}" && !quote) {
            this.dimension--;
            if (!this.dimension) {
              this.newEntry();
              if (nested) return this.entries;
            }
          } else if (character.value === '"' && !character.escaped) {
            if (quote) this.newEntry(true);
            quote = !quote;
          } else if (character.value === "," && !quote) {
            this.newEntry();
          } else {
            this.record(character.value);
          }
        }
        if (this.dimension !== 0) {
          throw new Error("array dimension not balanced");
        }
        return this.entries;
      }
    };
    function identity(value) {
      return value;
    }
  }
});

// node_modules/pg-types/lib/arrayParser.js
var require_arrayParser = __commonJS({
  "node_modules/pg-types/lib/arrayParser.js"(exports, module) {
    var array = require_postgres_array();
    module.exports = {
      create: function(source, transform) {
        return {
          parse: function() {
            return array.parse(source, transform);
          }
        };
      }
    };
  }
});

// node_modules/postgres-date/index.js
var require_postgres_date = __commonJS({
  "node_modules/postgres-date/index.js"(exports, module) {
    "use strict";
    var DATE_TIME = /(\d{1,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,})?.*?( BC)?$/;
    var DATE = /^(\d{1,})-(\d{2})-(\d{2})( BC)?$/;
    var TIME_ZONE = /([Z+-])(\d{2})?:?(\d{2})?:?(\d{2})?/;
    var INFINITY = /^-?infinity$/;
    module.exports = function parseDate(isoDate) {
      if (INFINITY.test(isoDate)) {
        return Number(isoDate.replace("i", "I"));
      }
      var matches = DATE_TIME.exec(isoDate);
      if (!matches) {
        return getDate(isoDate) || null;
      }
      var isBC = !!matches[8];
      var year = parseInt(matches[1], 10);
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var hour = parseInt(matches[4], 10);
      var minute = parseInt(matches[5], 10);
      var second = parseInt(matches[6], 10);
      var ms = matches[7];
      ms = ms ? 1e3 * parseFloat(ms) : 0;
      var date;
      var offset = timeZoneOffset(isoDate);
      if (offset != null) {
        date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
        if (is0To99(year)) {
          date.setUTCFullYear(year);
        }
        if (offset !== 0) {
          date.setTime(date.getTime() - offset);
        }
      } else {
        date = new Date(year, month, day, hour, minute, second, ms);
        if (is0To99(year)) {
          date.setFullYear(year);
        }
      }
      return date;
    };
    function getDate(isoDate) {
      var matches = DATE.exec(isoDate);
      if (!matches) {
        return;
      }
      var year = parseInt(matches[1], 10);
      var isBC = !!matches[4];
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var date = new Date(year, month, day);
      if (is0To99(year)) {
        date.setFullYear(year);
      }
      return date;
    }
    function timeZoneOffset(isoDate) {
      if (isoDate.endsWith("+00")) {
        return 0;
      }
      var zone = TIME_ZONE.exec(isoDate.split(" ")[1]);
      if (!zone) return;
      var type = zone[1];
      if (type === "Z") {
        return 0;
      }
      var sign = type === "-" ? -1 : 1;
      var offset = parseInt(zone[2], 10) * 3600 + parseInt(zone[3] || 0, 10) * 60 + parseInt(zone[4] || 0, 10);
      return offset * sign * 1e3;
    }
    function bcYearToNegativeYear(year) {
      return -(year - 1);
    }
    function is0To99(num) {
      return num >= 0 && num < 100;
    }
  }
});

// node_modules/xtend/mutable.js
var require_mutable = __commonJS({
  "node_modules/xtend/mutable.js"(exports, module) {
    module.exports = extend;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function extend(target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        for (var key in source) {
          if (hasOwnProperty.call(source, key)) {
            target[key] = source[key];
          }
        }
      }
      return target;
    }
  }
});

// node_modules/postgres-interval/index.js
var require_postgres_interval = __commonJS({
  "node_modules/postgres-interval/index.js"(exports, module) {
    "use strict";
    var extend = require_mutable();
    module.exports = PostgresInterval;
    function PostgresInterval(raw) {
      if (!(this instanceof PostgresInterval)) {
        return new PostgresInterval(raw);
      }
      extend(this, parse(raw));
    }
    var properties = ["seconds", "minutes", "hours", "days", "months", "years"];
    PostgresInterval.prototype.toPostgres = function() {
      var filtered = properties.filter(this.hasOwnProperty, this);
      if (this.milliseconds && filtered.indexOf("seconds") < 0) {
        filtered.push("seconds");
      }
      if (filtered.length === 0) return "0";
      return filtered.map(function(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/\.?0+$/, "");
        }
        return value + " " + property;
      }, this).join(" ");
    };
    var propertiesISOEquivalent = {
      years: "Y",
      months: "M",
      days: "D",
      hours: "H",
      minutes: "M",
      seconds: "S"
    };
    var dateProperties = ["years", "months", "days"];
    var timeProperties = ["hours", "minutes", "seconds"];
    PostgresInterval.prototype.toISOString = PostgresInterval.prototype.toISO = function() {
      var datePart = dateProperties.map(buildProperty, this).join("");
      var timePart = timeProperties.map(buildProperty, this).join("");
      return "P" + datePart + "T" + timePart;
      function buildProperty(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/0+$/, "");
        }
        return value + propertiesISOEquivalent[property];
      }
    };
    var NUMBER = "([+-]?\\d+)";
    var YEAR = NUMBER + "\\s+years?";
    var MONTH = NUMBER + "\\s+mons?";
    var DAY = NUMBER + "\\s+days?";
    var TIME = "([+-])?([\\d]*):(\\d\\d):(\\d\\d)\\.?(\\d{1,6})?";
    var INTERVAL = new RegExp([YEAR, MONTH, DAY, TIME].map(function(regexString) {
      return "(" + regexString + ")?";
    }).join("\\s*"));
    var positions = {
      years: 2,
      months: 4,
      days: 6,
      hours: 9,
      minutes: 10,
      seconds: 11,
      milliseconds: 12
    };
    var negatives = ["hours", "minutes", "seconds", "milliseconds"];
    function parseMilliseconds(fraction) {
      var microseconds = fraction + "000000".slice(fraction.length);
      return parseInt(microseconds, 10) / 1e3;
    }
    function parse(interval) {
      if (!interval) return {};
      var matches = INTERVAL.exec(interval);
      var isNegative = matches[8] === "-";
      return Object.keys(positions).reduce(function(parsed, property) {
        var position = positions[property];
        var value = matches[position];
        if (!value) return parsed;
        value = property === "milliseconds" ? parseMilliseconds(value) : parseInt(value, 10);
        if (!value) return parsed;
        if (isNegative && ~negatives.indexOf(property)) {
          value *= -1;
        }
        parsed[property] = value;
        return parsed;
      }, {});
    }
  }
});

// node_modules/postgres-bytea/index.js
var require_postgres_bytea = __commonJS({
  "node_modules/postgres-bytea/index.js"(exports, module) {
    "use strict";
    var bufferFrom = Buffer.from || Buffer;
    module.exports = function parseBytea(input) {
      if (/^\\x/.test(input)) {
        return bufferFrom(input.substr(2), "hex");
      }
      var output = "";
      var i = 0;
      while (i < input.length) {
        if (input[i] !== "\\") {
          output += input[i];
          ++i;
        } else {
          if (/[0-7]{3}/.test(input.substr(i + 1, 3))) {
            output += String.fromCharCode(parseInt(input.substr(i + 1, 3), 8));
            i += 4;
          } else {
            var backslashes = 1;
            while (i + backslashes < input.length && input[i + backslashes] === "\\") {
              backslashes++;
            }
            for (var k = 0; k < Math.floor(backslashes / 2); ++k) {
              output += "\\";
            }
            i += Math.floor(backslashes / 2) * 2;
          }
        }
      }
      return bufferFrom(output, "binary");
    };
  }
});

// node_modules/pg-types/lib/textParsers.js
var require_textParsers = __commonJS({
  "node_modules/pg-types/lib/textParsers.js"(exports, module) {
    var array = require_postgres_array();
    var arrayParser = require_arrayParser();
    var parseDate = require_postgres_date();
    var parseInterval = require_postgres_interval();
    var parseByteA = require_postgres_bytea();
    function allowNull(fn) {
      return function nullAllowed(value) {
        if (value === null) return value;
        return fn(value);
      };
    }
    function parseBool(value) {
      if (value === null) return value;
      return value === "TRUE" || value === "t" || value === "true" || value === "y" || value === "yes" || value === "on" || value === "1";
    }
    function parseBoolArray(value) {
      if (!value) return null;
      return array.parse(value, parseBool);
    }
    function parseBaseTenInt(string) {
      return parseInt(string, 10);
    }
    function parseIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(parseBaseTenInt));
    }
    function parseBigIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(function(entry) {
        return parseBigInteger(entry).trim();
      }));
    }
    var parsePointArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parsePoint(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseFloatArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseFloat(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseStringArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value);
      return p.parse();
    };
    var parseDateArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseDate(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseIntervalArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseInterval(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseByteAArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(parseByteA));
    };
    var parseInteger = function(value) {
      return parseInt(value, 10);
    };
    var parseBigInteger = function(value) {
      var valStr = String(value);
      if (/^\d+$/.test(valStr)) {
        return valStr;
      }
      return value;
    };
    var parseJsonArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(JSON.parse));
    };
    var parsePoint = function(value) {
      if (value[0] !== "(") {
        return null;
      }
      value = value.substring(1, value.length - 1).split(",");
      return {
        x: parseFloat(value[0]),
        y: parseFloat(value[1])
      };
    };
    var parseCircle = function(value) {
      if (value[0] !== "<" && value[1] !== "(") {
        return null;
      }
      var point = "(";
      var radius = "";
      var pointParsed = false;
      for (var i = 2; i < value.length - 1; i++) {
        if (!pointParsed) {
          point += value[i];
        }
        if (value[i] === ")") {
          pointParsed = true;
          continue;
        } else if (!pointParsed) {
          continue;
        }
        if (value[i] === ",") {
          continue;
        }
        radius += value[i];
      }
      var result = parsePoint(point);
      result.radius = parseFloat(radius);
      return result;
    };
    var init = function(register) {
      register(20, parseBigInteger);
      register(21, parseInteger);
      register(23, parseInteger);
      register(26, parseInteger);
      register(700, parseFloat);
      register(701, parseFloat);
      register(16, parseBool);
      register(1082, parseDate);
      register(1114, parseDate);
      register(1184, parseDate);
      register(600, parsePoint);
      register(651, parseStringArray);
      register(718, parseCircle);
      register(1e3, parseBoolArray);
      register(1001, parseByteAArray);
      register(1005, parseIntegerArray);
      register(1007, parseIntegerArray);
      register(1028, parseIntegerArray);
      register(1016, parseBigIntegerArray);
      register(1017, parsePointArray);
      register(1021, parseFloatArray);
      register(1022, parseFloatArray);
      register(1231, parseFloatArray);
      register(1014, parseStringArray);
      register(1015, parseStringArray);
      register(1008, parseStringArray);
      register(1009, parseStringArray);
      register(1040, parseStringArray);
      register(1041, parseStringArray);
      register(1115, parseDateArray);
      register(1182, parseDateArray);
      register(1185, parseDateArray);
      register(1186, parseInterval);
      register(1187, parseIntervalArray);
      register(17, parseByteA);
      register(114, JSON.parse.bind(JSON));
      register(3802, JSON.parse.bind(JSON));
      register(199, parseJsonArray);
      register(3807, parseJsonArray);
      register(3907, parseStringArray);
      register(2951, parseStringArray);
      register(791, parseStringArray);
      register(1183, parseStringArray);
      register(1270, parseStringArray);
    };
    module.exports = {
      init
    };
  }
});

// node_modules/pg-int8/index.js
var require_pg_int8 = __commonJS({
  "node_modules/pg-int8/index.js"(exports, module) {
    "use strict";
    var BASE = 1e6;
    function readInt8(buffer) {
      var high = buffer.readInt32BE(0);
      var low = buffer.readUInt32BE(4);
      var sign = "";
      if (high < 0) {
        high = ~high + (low === 0);
        low = ~low + 1 >>> 0;
        sign = "-";
      }
      var result = "";
      var carry;
      var t;
      var digits;
      var pad;
      var l;
      var i;
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        t = 4294967296 * carry + low;
        digits = "" + t % BASE;
        return sign + digits + result;
      }
    }
    module.exports = readInt8;
  }
});

// node_modules/pg-types/lib/binaryParsers.js
var require_binaryParsers = __commonJS({
  "node_modules/pg-types/lib/binaryParsers.js"(exports, module) {
    var parseInt64 = require_pg_int8();
    var parseBits = function(data, bits, offset, invert, callback) {
      offset = offset || 0;
      invert = invert || false;
      callback = callback || function(lastValue, newValue, bits2) {
        return lastValue * Math.pow(2, bits2) + newValue;
      };
      var offsetBytes = offset >> 3;
      var inv = function(value) {
        if (invert) {
          return ~value & 255;
        }
        return value;
      };
      var mask = 255;
      var firstBits = 8 - offset % 8;
      if (bits < firstBits) {
        mask = 255 << 8 - bits & 255;
        firstBits = bits;
      }
      if (offset) {
        mask = mask >> offset % 8;
      }
      var result = 0;
      if (offset % 8 + bits >= 8) {
        result = callback(0, inv(data[offsetBytes]) & mask, firstBits);
      }
      var bytes = bits + offset >> 3;
      for (var i = offsetBytes + 1; i < bytes; i++) {
        result = callback(result, inv(data[i]), 8);
      }
      var lastBits = (bits + offset) % 8;
      if (lastBits > 0) {
        result = callback(result, inv(data[bytes]) >> 8 - lastBits, lastBits);
      }
      return result;
    };
    var parseFloatFromBits = function(data, precisionBits, exponentBits) {
      var bias = Math.pow(2, exponentBits - 1) - 1;
      var sign = parseBits(data, 1);
      var exponent = parseBits(data, exponentBits, 1);
      if (exponent === 0) {
        return 0;
      }
      var precisionBitsCounter = 1;
      var parsePrecisionBits = function(lastValue, newValue, bits) {
        if (lastValue === 0) {
          lastValue = 1;
        }
        for (var i = 1; i <= bits; i++) {
          precisionBitsCounter /= 2;
          if ((newValue & 1 << bits - i) > 0) {
            lastValue += precisionBitsCounter;
          }
        }
        return lastValue;
      };
      var mantissa = parseBits(data, precisionBits, exponentBits + 1, false, parsePrecisionBits);
      if (exponent == Math.pow(2, exponentBits + 1) - 1) {
        if (mantissa === 0) {
          return sign === 0 ? Infinity : -Infinity;
        }
        return NaN;
      }
      return (sign === 0 ? 1 : -1) * Math.pow(2, exponent - bias) * mantissa;
    };
    var parseInt16 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 15, 1, true) + 1);
      }
      return parseBits(value, 15, 1);
    };
    var parseInt32 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 31, 1, true) + 1);
      }
      return parseBits(value, 31, 1);
    };
    var parseFloat32 = function(value) {
      return parseFloatFromBits(value, 23, 8);
    };
    var parseFloat64 = function(value) {
      return parseFloatFromBits(value, 52, 11);
    };
    var parseNumeric = function(value) {
      var sign = parseBits(value, 16, 32);
      if (sign == 49152) {
        return NaN;
      }
      var weight = Math.pow(1e4, parseBits(value, 16, 16));
      var result = 0;
      var digits = [];
      var ndigits = parseBits(value, 16);
      for (var i = 0; i < ndigits; i++) {
        result += parseBits(value, 16, 64 + 16 * i) * weight;
        weight /= 1e4;
      }
      var scale = Math.pow(10, parseBits(value, 16, 48));
      return (sign === 0 ? 1 : -1) * Math.round(result * scale) / scale;
    };
    var parseDate = function(isUTC, value) {
      var sign = parseBits(value, 1);
      var rawValue = parseBits(value, 63, 1);
      var result = new Date((sign === 0 ? 1 : -1) * rawValue / 1e3 + 9466848e5);
      if (!isUTC) {
        result.setTime(result.getTime() + result.getTimezoneOffset() * 6e4);
      }
      result.usec = rawValue % 1e3;
      result.getMicroSeconds = function() {
        return this.usec;
      };
      result.setMicroSeconds = function(value2) {
        this.usec = value2;
      };
      result.getUTCMicroSeconds = function() {
        return this.usec;
      };
      return result;
    };
    var parseArray = function(value) {
      var dim = parseBits(value, 32);
      var flags = parseBits(value, 32, 32);
      var elementType = parseBits(value, 32, 64);
      var offset = 96;
      var dims = [];
      for (var i = 0; i < dim; i++) {
        dims[i] = parseBits(value, 32, offset);
        offset += 32;
        offset += 32;
      }
      var parseElement = function(elementType2) {
        var length = parseBits(value, 32, offset);
        offset += 32;
        if (length == 4294967295) {
          return null;
        }
        var result;
        if (elementType2 == 23 || elementType2 == 20) {
          result = parseBits(value, length * 8, offset);
          offset += length * 8;
          return result;
        } else if (elementType2 == 25) {
          result = value.toString(this.encoding, offset >> 3, (offset += length << 3) >> 3);
          return result;
        } else {
          console.log("ERROR: ElementType not implemented: " + elementType2);
        }
      };
      var parse = function(dimension, elementType2) {
        var array = [];
        var i2;
        if (dimension.length > 1) {
          var count = dimension.shift();
          for (i2 = 0; i2 < count; i2++) {
            array[i2] = parse(dimension, elementType2);
          }
          dimension.unshift(count);
        } else {
          for (i2 = 0; i2 < dimension[0]; i2++) {
            array[i2] = parseElement(elementType2);
          }
        }
        return array;
      };
      return parse(dims, elementType);
    };
    var parseText = function(value) {
      return value.toString("utf8");
    };
    var parseBool = function(value) {
      if (value === null) return null;
      return parseBits(value, 8) > 0;
    };
    var init = function(register) {
      register(20, parseInt64);
      register(21, parseInt16);
      register(23, parseInt32);
      register(26, parseInt32);
      register(1700, parseNumeric);
      register(700, parseFloat32);
      register(701, parseFloat64);
      register(16, parseBool);
      register(1114, parseDate.bind(null, false));
      register(1184, parseDate.bind(null, true));
      register(1e3, parseArray);
      register(1007, parseArray);
      register(1016, parseArray);
      register(1008, parseArray);
      register(1009, parseArray);
      register(25, parseText);
    };
    module.exports = {
      init
    };
  }
});

// node_modules/pg-types/lib/builtins.js
var require_builtins = __commonJS({
  "node_modules/pg-types/lib/builtins.js"(exports, module) {
    module.exports = {
      BOOL: 16,
      BYTEA: 17,
      CHAR: 18,
      INT8: 20,
      INT2: 21,
      INT4: 23,
      REGPROC: 24,
      TEXT: 25,
      OID: 26,
      TID: 27,
      XID: 28,
      CID: 29,
      JSON: 114,
      XML: 142,
      PG_NODE_TREE: 194,
      SMGR: 210,
      PATH: 602,
      POLYGON: 604,
      CIDR: 650,
      FLOAT4: 700,
      FLOAT8: 701,
      ABSTIME: 702,
      RELTIME: 703,
      TINTERVAL: 704,
      CIRCLE: 718,
      MACADDR8: 774,
      MONEY: 790,
      MACADDR: 829,
      INET: 869,
      ACLITEM: 1033,
      BPCHAR: 1042,
      VARCHAR: 1043,
      DATE: 1082,
      TIME: 1083,
      TIMESTAMP: 1114,
      TIMESTAMPTZ: 1184,
      INTERVAL: 1186,
      TIMETZ: 1266,
      BIT: 1560,
      VARBIT: 1562,
      NUMERIC: 1700,
      REFCURSOR: 1790,
      REGPROCEDURE: 2202,
      REGOPER: 2203,
      REGOPERATOR: 2204,
      REGCLASS: 2205,
      REGTYPE: 2206,
      UUID: 2950,
      TXID_SNAPSHOT: 2970,
      PG_LSN: 3220,
      PG_NDISTINCT: 3361,
      PG_DEPENDENCIES: 3402,
      TSVECTOR: 3614,
      TSQUERY: 3615,
      GTSVECTOR: 3642,
      REGCONFIG: 3734,
      REGDICTIONARY: 3769,
      JSONB: 3802,
      REGNAMESPACE: 4089,
      REGROLE: 4096
    };
  }
});

// node_modules/pg-types/index.js
var require_pg_types = __commonJS({
  "node_modules/pg-types/index.js"(exports) {
    var textParsers = require_textParsers();
    var binaryParsers = require_binaryParsers();
    var arrayParser = require_arrayParser();
    var builtinTypes = require_builtins();
    exports.getTypeParser = getTypeParser;
    exports.setTypeParser = setTypeParser;
    exports.arrayParser = arrayParser;
    exports.builtins = builtinTypes;
    var typeParsers = {
      text: {},
      binary: {}
    };
    function noParse(val) {
      return String(val);
    }
    function getTypeParser(oid, format) {
      format = format || "text";
      if (!typeParsers[format]) {
        return noParse;
      }
      return typeParsers[format][oid] || noParse;
    }
    function setTypeParser(oid, format, parseFn) {
      if (typeof format == "function") {
        parseFn = format;
        format = "text";
      }
      typeParsers[format][oid] = parseFn;
    }
    textParsers.init(function(oid, converter) {
      typeParsers.text[oid] = converter;
    });
    binaryParsers.init(function(oid, converter) {
      typeParsers.binary[oid] = converter;
    });
  }
});

// node_modules/pg/lib/defaults.js
var require_defaults = __commonJS({
  "node_modules/pg/lib/defaults.js"(exports, module) {
    "use strict";
    var user;
    try {
      user = process.platform === "win32" ? process.env.USERNAME : process.env.USER;
    } catch {
    }
    module.exports = {
      // database host. defaults to localhost
      host: "localhost",
      // database user's name
      user,
      // name of database to connect
      database: void 0,
      // database user's password
      password: null,
      // a Postgres connection string to be used instead of setting individual connection items
      // NOTE:  Setting this value will cause it to override any other value (such as database or user) defined
      // in the defaults object.
      connectionString: void 0,
      // database port
      port: 5432,
      // number of rows to return at a time from a prepared statement's
      // portal. 0 will return all rows at once
      rows: 0,
      // binary result mode
      binary: false,
      // Connection pool options - see https://github.com/brianc/node-pg-pool
      // number of connections to use in connection pool
      // 0 will disable connection pooling
      max: 10,
      // max milliseconds a client can go unused before it is removed
      // from the pool and destroyed
      idleTimeoutMillis: 3e4,
      client_encoding: "",
      ssl: false,
      // SSL negotiation style: 'postgres' (traditional SSLRequest) or 'direct'
      sslnegotiation: void 0,
      application_name: void 0,
      fallback_application_name: void 0,
      options: void 0,
      parseInputDatesAsUTC: false,
      // max milliseconds any query using this connection will execute for before timing out in error.
      // false=unlimited
      statement_timeout: false,
      // Abort any statement that waits longer than the specified duration in milliseconds while attempting to acquire a lock.
      // false=unlimited
      lock_timeout: false,
      // Terminate any session with an open transaction that has been idle for longer than the specified duration in milliseconds
      // false=unlimited
      idle_in_transaction_session_timeout: false,
      // max milliseconds to wait for query to complete (client side)
      query_timeout: false,
      connect_timeout: 0,
      keepalives: 1,
      keepalives_idle: 0
    };
    var pgTypes = require_pg_types();
    var parseBigInteger = pgTypes.getTypeParser(20, "text");
    var parseBigIntegerArray = pgTypes.getTypeParser(1016, "text");
    module.exports.__defineSetter__("parseInt8", function(val) {
      pgTypes.setTypeParser(20, "text", val ? pgTypes.getTypeParser(23, "text") : parseBigInteger);
      pgTypes.setTypeParser(1016, "text", val ? pgTypes.getTypeParser(1007, "text") : parseBigIntegerArray);
    });
  }
});

// node_modules/pg/lib/utils.js
var require_utils = __commonJS({
  "node_modules/pg/lib/utils.js"(exports, module) {
    "use strict";
    var defaults2 = require_defaults();
    var { isDate } = __require("util/types");
    function escapeElement(elementRepresentation) {
      const escaped = elementRepresentation.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return '"' + escaped + '"';
    }
    function arrayString(val) {
      let result = "{";
      for (let i = 0; i < val.length; i++) {
        if (i > 0) {
          result += ",";
        }
        let item = val[i];
        if (item == null) {
          result += "NULL";
        } else if (Array.isArray(item)) {
          result += arrayString(item);
        } else if (ArrayBuffer.isView(item)) {
          if (!(item instanceof Buffer)) {
            item = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
          }
          result += "\\\\x" + item.toString("hex");
        } else {
          result += escapeElement(prepareValue(item));
        }
      }
      result += "}";
      return result;
    }
    var prepareValue = function(val, seen) {
      if (val == null) {
        return null;
      }
      if (typeof val === "object") {
        if (val instanceof Buffer) {
          return val;
        }
        if (ArrayBuffer.isView(val)) {
          return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
        }
        if (isDate(val)) {
          if (defaults2.parseInputDatesAsUTC) {
            return dateToStringUTC(val);
          } else {
            return dateToString(val);
          }
        }
        if (Array.isArray(val)) {
          return arrayString(val);
        }
        return prepareObject(val, seen);
      }
      return val.toString();
    };
    function prepareObject(val, seen) {
      if (val && typeof val.toPostgres === "function") {
        seen = seen || [];
        if (seen.indexOf(val) !== -1) {
          throw new Error('circular reference detected while preparing "' + val + '" for query');
        }
        seen.push(val);
        return prepareValue(val.toPostgres(prepareValue), seen);
      }
      return JSON.stringify(val);
    }
    function dateToString(date) {
      let offset = -date.getTimezoneOffset();
      let year = date.getFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + "T" + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" + String(date.getSeconds()).padStart(2, "0") + "." + String(date.getMilliseconds()).padStart(3, "0");
      if (offset < 0) {
        ret += "-";
        offset *= -1;
      } else {
        ret += "+";
      }
      ret += String(Math.floor(offset / 60)).padStart(2, "0") + ":" + String(offset % 60).padStart(2, "0");
      if (isBCYear) ret += " BC";
      return ret;
    }
    function dateToStringUTC(date) {
      let year = date.getUTCFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0") + "T" + String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0") + ":" + String(date.getUTCSeconds()).padStart(2, "0") + "." + String(date.getUTCMilliseconds()).padStart(3, "0");
      ret += "+00:00";
      if (isBCYear) ret += " BC";
      return ret;
    }
    function normalizeQueryConfig(config, values, callback) {
      config = typeof config === "string" ? { text: config } : config;
      if (values) {
        if (typeof values === "function") {
          config.callback = values;
        } else {
          config.values = values;
        }
      }
      if (callback) {
        config.callback = callback;
      }
      return config;
    }
    var escapeIdentifier2 = function(str) {
      return '"' + str.replace(/"/g, '""') + '"';
    };
    var escapeLiteral2 = function(str) {
      let hasBackslash = false;
      let escaped = "'";
      if (str == null) {
        return "''";
      }
      if (typeof str !== "string") {
        return "''";
      }
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === "'") {
          escaped += c + c;
        } else if (c === "\\") {
          escaped += c + c;
          hasBackslash = true;
        } else {
          escaped += c;
        }
      }
      escaped += "'";
      if (hasBackslash === true) {
        escaped = " E" + escaped;
      }
      return escaped;
    };
    module.exports = {
      prepareValue: function prepareValueWrapper(value) {
        return prepareValue(value);
      },
      normalizeQueryConfig,
      escapeIdentifier: escapeIdentifier2,
      escapeLiteral: escapeLiteral2
    };
  }
});

// node_modules/pg/lib/crypto/utils.js
var require_utils2 = __commonJS({
  "node_modules/pg/lib/crypto/utils.js"(exports, module) {
    var nodeCrypto = __require("crypto");
    module.exports = {
      postgresMd5PasswordHash,
      randomBytes,
      deriveKey,
      sha256,
      hashByName,
      hmacSha256,
      md5
    };
    var webCrypto = nodeCrypto.webcrypto || globalThis.crypto;
    var subtleCrypto = webCrypto.subtle;
    var textEncoder = new TextEncoder();
    function randomBytes(length) {
      return webCrypto.getRandomValues(Buffer.alloc(length));
    }
    async function md5(string) {
      try {
        return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
      } catch (e) {
        const data = typeof string === "string" ? textEncoder.encode(string) : string;
        const hash = await subtleCrypto.digest("MD5", data);
        return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    }
    async function postgresMd5PasswordHash(user, password, salt) {
      const inner = await md5(password + user);
      const outer = await md5(Buffer.concat([Buffer.from(inner), salt]));
      return "md5" + outer;
    }
    async function sha256(text) {
      return await subtleCrypto.digest("SHA-256", text);
    }
    async function hashByName(hashName, text) {
      return await subtleCrypto.digest(hashName, text);
    }
    async function hmacSha256(keyBuffer, msg) {
      const key = await subtleCrypto.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return await subtleCrypto.sign("HMAC", key, textEncoder.encode(msg));
    }
    async function deriveKey(password, salt, iterations) {
      const key = await subtleCrypto.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
      const params = { name: "PBKDF2", hash: "SHA-256", salt, iterations };
      return await subtleCrypto.deriveBits(params, key, 32 * 8, ["deriveBits"]);
    }
  }
});

// node_modules/pg/lib/crypto/cert-signatures.js
var require_cert_signatures = __commonJS({
  "node_modules/pg/lib/crypto/cert-signatures.js"(exports, module) {
    function x509Error(msg, cert) {
      return new Error("SASL channel binding: " + msg + " when parsing public certificate " + cert.toString("base64"));
    }
    function readASN1Length(data, index) {
      let length = data[index++];
      if (length < 128) return { length, index };
      const lengthBytes = length & 127;
      if (lengthBytes > 4) throw x509Error("bad length", data);
      length = 0;
      for (let i = 0; i < lengthBytes; i++) {
        length = length << 8 | data[index++];
      }
      return { length, index };
    }
    function readASN1OID(data, index) {
      if (data[index++] !== 6) throw x509Error("non-OID data", data);
      const { length: OIDLength, index: indexAfterOIDLength } = readASN1Length(data, index);
      index = indexAfterOIDLength;
      const lastIndex = index + OIDLength;
      const byte1 = data[index++];
      let oid = (byte1 / 40 >> 0) + "." + byte1 % 40;
      while (index < lastIndex) {
        let value = 0;
        while (index < lastIndex) {
          const nextByte = data[index++];
          value = value << 7 | nextByte & 127;
          if (nextByte < 128) break;
        }
        oid += "." + value;
      }
      return { oid, index };
    }
    function expectASN1Seq(data, index) {
      if (data[index++] !== 48) throw x509Error("non-sequence data", data);
      return readASN1Length(data, index);
    }
    function signatureAlgorithmHashFromCertificate(data, index) {
      if (index === void 0) index = 0;
      index = expectASN1Seq(data, index).index;
      const { length: certInfoLength, index: indexAfterCertInfoLength } = expectASN1Seq(data, index);
      index = indexAfterCertInfoLength + certInfoLength;
      index = expectASN1Seq(data, index).index;
      const { oid, index: indexAfterOID } = readASN1OID(data, index);
      switch (oid) {
        // RSA
        case "1.2.840.113549.1.1.4":
          return "MD5";
        case "1.2.840.113549.1.1.5":
          return "SHA-1";
        case "1.2.840.113549.1.1.11":
          return "SHA-256";
        case "1.2.840.113549.1.1.12":
          return "SHA-384";
        case "1.2.840.113549.1.1.13":
          return "SHA-512";
        case "1.2.840.113549.1.1.14":
          return "SHA-224";
        case "1.2.840.113549.1.1.15":
          return "SHA512-224";
        case "1.2.840.113549.1.1.16":
          return "SHA512-256";
        // ECDSA
        case "1.2.840.10045.4.1":
          return "SHA-1";
        case "1.2.840.10045.4.3.1":
          return "SHA-224";
        case "1.2.840.10045.4.3.2":
          return "SHA-256";
        case "1.2.840.10045.4.3.3":
          return "SHA-384";
        case "1.2.840.10045.4.3.4":
          return "SHA-512";
        // RSASSA-PSS: hash is indicated separately
        case "1.2.840.113549.1.1.10": {
          index = indexAfterOID;
          index = expectASN1Seq(data, index).index;
          if (data[index++] !== 160) throw x509Error("non-tag data", data);
          index = readASN1Length(data, index).index;
          index = expectASN1Seq(data, index).index;
          const { oid: hashOID } = readASN1OID(data, index);
          switch (hashOID) {
            // standalone hash OIDs
            case "1.2.840.113549.2.5":
              return "MD5";
            case "1.3.14.3.2.26":
              return "SHA-1";
            case "2.16.840.1.101.3.4.2.1":
              return "SHA-256";
            case "2.16.840.1.101.3.4.2.2":
              return "SHA-384";
            case "2.16.840.1.101.3.4.2.3":
              return "SHA-512";
          }
          throw x509Error("unknown hash OID " + hashOID, data);
        }
        // Ed25519 -- see https: return//github.com/openssl/openssl/issues/15477
        case "1.3.101.110":
        case "1.3.101.112":
          return "SHA-512";
        // Ed448 -- still not in pg 17.2 (if supported, digest would be SHAKE256 x 64 bytes)
        case "1.3.101.111":
        case "1.3.101.113":
          throw x509Error("Ed448 certificate channel binding is not currently supported by Postgres");
      }
      throw x509Error("unknown OID " + oid, data);
    }
    module.exports = { signatureAlgorithmHashFromCertificate };
  }
});

// node_modules/pg/lib/crypto/sasl.js
var require_sasl = __commonJS({
  "node_modules/pg/lib/crypto/sasl.js"(exports, module) {
    "use strict";
    var crypto = require_utils2();
    var { signatureAlgorithmHashFromCertificate } = require_cert_signatures();
    function saslprep(password) {
      const nonAsciiSpace = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g;
      const mappedToNothing = /[\u00AD\u034F\u1806\u180B\u180C\u180D\u200C\u200D\u2060\uFE00-\uFE0F\uFEFF]/g;
      return password.replace(nonAsciiSpace, " ").replace(mappedToNothing, "").normalize("NFKC");
    }
    var DEFAULT_MAX_SCRAM_ITERATIONS = 1e5;
    function startSession(mechanisms, stream, scramMaxIterations = DEFAULT_MAX_SCRAM_ITERATIONS) {
      const candidates = ["SCRAM-SHA-256"];
      if (stream) candidates.unshift("SCRAM-SHA-256-PLUS");
      const mechanism = candidates.find((candidate) => mechanisms.includes(candidate));
      if (!mechanism) {
        throw new Error("SASL: Only mechanism(s) " + candidates.join(" and ") + " are supported");
      }
      if (mechanism === "SCRAM-SHA-256-PLUS" && typeof stream.getPeerCertificate !== "function") {
        throw new Error("SASL: Mechanism SCRAM-SHA-256-PLUS requires a certificate");
      }
      const clientNonce = crypto.randomBytes(18).toString("base64");
      const gs2Header = mechanism === "SCRAM-SHA-256-PLUS" ? "p=tls-server-end-point" : stream ? "y" : "n";
      return {
        mechanism,
        clientNonce,
        response: gs2Header + ",,n=*,r=" + clientNonce,
        message: "SASLInitialResponse",
        scramMaxIterations
      };
    }
    async function continueSession(session, password, serverData, stream) {
      if (session.message !== "SASLInitialResponse") {
        throw new Error("SASL: Last message was not SASLInitialResponse");
      }
      if (typeof password !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
      }
      if (password === "") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: serverData must be a string");
      }
      const sv = parseServerFirstMessage(serverData);
      if (!sv.nonce.startsWith(session.clientNonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce");
      } else if (sv.nonce.length === session.clientNonce.length) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short");
      }
      const scramMaxIterations = typeof session.scramMaxIterations === "number" ? session.scramMaxIterations : DEFAULT_MAX_SCRAM_ITERATIONS;
      if (scramMaxIterations !== 0 && sv.iteration > scramMaxIterations) {
        throw new Error(
          "SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration count " + sv.iteration + " exceeds scramMaxIterations of " + scramMaxIterations
        );
      }
      const clientFirstMessageBare = "n=*,r=" + session.clientNonce;
      const serverFirstMessage = "r=" + sv.nonce + ",s=" + sv.salt + ",i=" + sv.iteration;
      let channelBinding = stream ? "eSws" : "biws";
      if (session.mechanism === "SCRAM-SHA-256-PLUS") {
        const peerCert = stream.getPeerCertificate().raw;
        let hashName = signatureAlgorithmHashFromCertificate(peerCert);
        if (hashName === "MD5" || hashName === "SHA-1") hashName = "SHA-256";
        const certHash = await crypto.hashByName(hashName, peerCert);
        const bindingData = Buffer.concat([Buffer.from("p=tls-server-end-point,,"), Buffer.from(certHash)]);
        channelBinding = bindingData.toString("base64");
      }
      const clientFinalMessageWithoutProof = "c=" + channelBinding + ",r=" + sv.nonce;
      const authMessage = clientFirstMessageBare + "," + serverFirstMessage + "," + clientFinalMessageWithoutProof;
      const saltBytes = Buffer.from(sv.salt, "base64");
      const saltedPassword = await crypto.deriveKey(saslprep(password), saltBytes, sv.iteration);
      const clientKey = await crypto.hmacSha256(saltedPassword, "Client Key");
      const storedKey = await crypto.sha256(clientKey);
      const clientSignature = await crypto.hmacSha256(storedKey, authMessage);
      const clientProof = xorBuffers(Buffer.from(clientKey), Buffer.from(clientSignature)).toString("base64");
      const serverKey = await crypto.hmacSha256(saltedPassword, "Server Key");
      const serverSignatureBytes = await crypto.hmacSha256(serverKey, authMessage);
      session.message = "SASLResponse";
      session.serverSignature = Buffer.from(serverSignatureBytes).toString("base64");
      session.response = clientFinalMessageWithoutProof + ",p=" + clientProof;
    }
    function finalizeSession(session, serverData) {
      if (session.message !== "SASLResponse") {
        throw new Error("SASL: Last message was not SASLResponse");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: serverData must be a string");
      }
      const { serverSignature } = parseServerFinalMessage(serverData);
      if (serverSignature !== session.serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match");
      }
    }
    function isPrintableChars(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: text must be a string");
      }
      return text.split("").map((_, i) => text.charCodeAt(i)).every((c) => c >= 33 && c <= 43 || c >= 45 && c <= 126);
    }
    function isBase64(text) {
      return /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(text);
    }
    function parseAttributePairs(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: attribute pairs text must be a string");
      }
      return new Map(
        text.split(",").map((attrValue) => {
          if (!/^.=/.test(attrValue)) {
            throw new Error("SASL: Invalid attribute pair entry");
          }
          const name = attrValue[0];
          const value = attrValue.substring(2);
          return [name, value];
        })
      );
    }
    function parseServerFirstMessage(data) {
      const attrPairs = parseAttributePairs(data);
      const nonce = attrPairs.get("r");
      if (!nonce) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing");
      } else if (!isPrintableChars(nonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce must only contain printable characters");
      }
      const salt = attrPairs.get("s");
      if (!salt) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing");
      } else if (!isBase64(salt)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt must be base64");
      }
      const iterationText = attrPairs.get("i");
      if (!iterationText) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration missing");
      } else if (!/^[1-9][0-9]*$/.test(iterationText)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: invalid iteration count");
      }
      const iteration = parseInt(iterationText, 10);
      return {
        nonce,
        salt,
        iteration
      };
    }
    function parseServerFinalMessage(serverData) {
      const attrPairs = parseAttributePairs(serverData);
      const error = attrPairs.get("e");
      const serverSignature = attrPairs.get("v");
      if (error) {
        throw new Error(`SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error: "${error}"`);
      }
      if (!serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing");
      } else if (!isBase64(serverSignature)) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature must be base64");
      }
      return {
        serverSignature
      };
    }
    function xorBuffers(a, b) {
      if (!Buffer.isBuffer(a)) {
        throw new TypeError("first argument must be a Buffer");
      }
      if (!Buffer.isBuffer(b)) {
        throw new TypeError("second argument must be a Buffer");
      }
      if (a.length !== b.length) {
        throw new Error("Buffer lengths must match");
      }
      if (a.length === 0) {
        throw new Error("Buffers cannot be empty");
      }
      return Buffer.from(a.map((_, i) => a[i] ^ b[i]));
    }
    module.exports = {
      startSession,
      continueSession,
      finalizeSession,
      DEFAULT_MAX_SCRAM_ITERATIONS
    };
  }
});

// node_modules/pg/lib/type-overrides.js
var require_type_overrides = __commonJS({
  "node_modules/pg/lib/type-overrides.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    function TypeOverrides2(userTypes) {
      this._types = userTypes || types2;
      this.text = {};
      this.binary = {};
    }
    TypeOverrides2.prototype.getOverrides = function(format) {
      switch (format) {
        case "text":
          return this.text;
        case "binary":
          return this.binary;
        default:
          return {};
      }
    };
    TypeOverrides2.prototype.setTypeParser = function(oid, format, parseFn) {
      if (typeof format === "function") {
        parseFn = format;
        format = "text";
      }
      this.getOverrides(format)[oid] = parseFn;
    };
    TypeOverrides2.prototype.getTypeParser = function(oid, format) {
      format = format || "text";
      return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format);
    };
    module.exports = TypeOverrides2;
  }
});

// node_modules/pg-connection-string/index.js
var require_pg_connection_string = __commonJS({
  "node_modules/pg-connection-string/index.js"(exports, module) {
    "use strict";
    function parse(str, options = {}) {
      if (str.charAt(0) === "/") {
        const config2 = str.split(" ");
        return { host: config2[0], database: config2[1] };
      }
      const config = /* @__PURE__ */ Object.create(null);
      let result;
      let dummyHost = false;
      if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
        str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
      }
      try {
        try {
          result = new URL(str, "postgres://base");
        } catch (e) {
          result = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
          dummyHost = true;
        }
      } catch (err) {
        err.input && (err.input = "*****REDACTED*****");
        throw err;
      }
      for (const entry of result.searchParams.entries()) {
        config[entry[0]] = entry[1];
      }
      config.user = config.user || decodeURIComponent(result.username);
      config.password = config.password || decodeURIComponent(result.password);
      if (result.protocol == "socket:") {
        config.host = decodeURI(result.pathname);
        config.database = result.searchParams.get("db");
        config.client_encoding = result.searchParams.get("encoding");
        return config;
      }
      const hostname = dummyHost ? "" : result.hostname;
      if (!config.host) {
        config.host = decodeURIComponent(hostname);
      } else if (hostname && /^%2f/i.test(hostname)) {
        result.pathname = hostname + result.pathname;
      }
      if (!config.port) {
        config.port = result.port;
      }
      const pathname = result.pathname.slice(1) || null;
      config.database = pathname ? decodeURI(pathname) : null;
      if (config.ssl === "true" || config.ssl === "1") {
        config.ssl = true;
      }
      if (config.ssl === "0") {
        config.ssl = false;
      }
      if (config.sslcert || config.sslkey || config.sslrootcert || config.sslmode) {
        config.ssl = {};
      }
      if (config.sslnegotiation === "direct" && config.ssl === void 0) {
        config.ssl = true;
      }
      const fs = config.sslcert || config.sslkey || config.sslrootcert ? __require("fs") : null;
      if (config.sslcert) {
        config.ssl.cert = fs.readFileSync(config.sslcert).toString();
      }
      if (config.sslkey) {
        config.ssl.key = fs.readFileSync(config.sslkey).toString();
      }
      if (config.sslrootcert) {
        config.ssl.ca = fs.readFileSync(config.sslrootcert).toString();
      }
      if (options.useLibpqCompat && config.uselibpqcompat) {
        throw new Error("Both useLibpqCompat and uselibpqcompat are set. Please use only one of them.");
      }
      if (config.uselibpqcompat === "true" || options.useLibpqCompat) {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
          case "require": {
            if (config.sslrootcert) {
              config.ssl.checkServerIdentity = function() {
              };
            } else {
              config.ssl.rejectUnauthorized = false;
            }
            break;
          }
          case "verify-ca": {
            if (!config.ssl.ca) {
              throw new Error(
                "SECURITY WARNING: Using sslmode=verify-ca requires specifying a CA with sslrootcert. If a public CA is used, verify-ca allows connections to a server that somebody else may have registered with the CA, making you vulnerable to Man-in-the-Middle attacks. Either specify a custom CA certificate with sslrootcert parameter or use sslmode=verify-full for proper security."
              );
            }
            config.ssl.checkServerIdentity = function() {
            };
            break;
          }
          case "verify-full": {
            break;
          }
        }
      } else {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer":
          case "require":
          case "verify-ca":
          case "verify-full": {
            if (config.sslmode !== "verify-full") {
              deprecatedSslModeWarning(config.sslmode);
            }
            break;
          }
          case "no-verify": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
        }
      }
      return config;
    }
    function toConnectionOptions(sslConfig) {
      const connectionOptions = Object.entries(sslConfig).reduce((c, [key, value]) => {
        if (value !== void 0 && value !== null) {
          c[key] = value;
        }
        return c;
      }, /* @__PURE__ */ Object.create(null));
      return connectionOptions;
    }
    function toClientConfig(config) {
      const poolConfig = Object.entries(config).reduce((c, [key, value]) => {
        if (key === "ssl") {
          const sslConfig = value;
          if (typeof sslConfig === "boolean") {
            c[key] = sslConfig;
          }
          if (typeof sslConfig === "object") {
            c[key] = toConnectionOptions(sslConfig);
          }
        } else if (value !== void 0 && value !== null) {
          if (key === "port") {
            if (value !== "") {
              const v = parseInt(value, 10);
              if (isNaN(v)) {
                throw new Error(`Invalid ${key}: ${value}`);
              }
              c[key] = v;
            }
          } else {
            c[key] = value;
          }
        }
        return c;
      }, /* @__PURE__ */ Object.create(null));
      return poolConfig;
    }
    function parseIntoClientConfig(str) {
      return toClientConfig(parse(str));
    }
    function deprecatedSslModeWarning(sslmode) {
      if (!deprecatedSslModeWarning.warned && typeof process !== "undefined" && process.emitWarning) {
        deprecatedSslModeWarning.warned = true;
        process.emitWarning(`SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=${sslmode}'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.`);
      }
    }
    module.exports = parse;
    parse.parse = parse;
    parse.toClientConfig = toClientConfig;
    parse.parseIntoClientConfig = parseIntoClientConfig;
  }
});

// node_modules/pg/lib/connection-parameters.js
var require_connection_parameters = __commonJS({
  "node_modules/pg/lib/connection-parameters.js"(exports, module) {
    "use strict";
    var dns = __require("dns");
    var defaults2 = require_defaults();
    var parse = require_pg_connection_string().parse;
    var val = function(key, config, envVar) {
      if (config[key]) {
        return config[key];
      }
      if (envVar === void 0) {
        envVar = process.env["PG" + key.toUpperCase()];
      } else if (envVar === false) {
      } else {
        envVar = process.env[envVar];
      }
      return envVar || defaults2[key];
    };
    var readSSLConfigFromEnvironment = function() {
      switch (process.env.PGSSLMODE) {
        case "disable":
          return false;
        case "prefer":
        case "require":
        case "verify-ca":
        case "verify-full":
          return true;
        case "no-verify":
          return { rejectUnauthorized: false };
      }
      return defaults2.ssl;
    };
    var quoteParamValue = function(value) {
      return "'" + ("" + value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    };
    var add = function(params, config, paramName) {
      const value = config[paramName];
      if (value !== void 0 && value !== null) {
        params.push(paramName + "=" + quoteParamValue(value));
      }
    };
    var ConnectionParameters = class {
      constructor(config) {
        config = typeof config === "string" ? parse(config) : config || {};
        if (config.connectionString) {
          config = Object.assign({}, config, parse(config.connectionString));
        }
        this.user = val("user", config);
        this.database = val("database", config);
        if (this.database === void 0) {
          this.database = this.user;
        }
        this.port = parseInt(val("port", config), 10);
        this.host = val("host", config);
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: val("password", config)
        });
        this.binary = val("binary", config);
        this.options = val("options", config);
        this.ssl = typeof config.ssl === "undefined" ? readSSLConfigFromEnvironment() : config.ssl;
        if (typeof this.ssl === "string") {
          if (this.ssl === "true") {
            this.ssl = true;
          }
        }
        if (this.ssl === "no-verify") {
          this.ssl = { rejectUnauthorized: false };
        }
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this.sslnegotiation = val("sslnegotiation", config, "PGSSLNEGOTIATION");
        if (this.sslnegotiation !== void 0 && this.sslnegotiation !== "postgres" && this.sslnegotiation !== "direct") {
          throw new Error(
            `Invalid sslnegotiation value: "${this.sslnegotiation}". Valid values are "postgres" and "direct".`
          );
        }
        if (this.sslnegotiation === "direct" && !this.ssl) {
          throw new Error("sslnegotiation=direct requires SSL to be enabled");
        }
        this.client_encoding = val("client_encoding", config);
        this.replication = val("replication", config);
        this.isDomainSocket = !(this.host || "").indexOf("/");
        this.application_name = val("application_name", config, "PGAPPNAME");
        this.fallback_application_name = val("fallback_application_name", config, false);
        this.statement_timeout = val("statement_timeout", config, false);
        this.lock_timeout = val("lock_timeout", config, false);
        this.idle_in_transaction_session_timeout = val("idle_in_transaction_session_timeout", config, false);
        this.query_timeout = val("query_timeout", config, false);
        if (config.connectionTimeoutMillis === void 0) {
          this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0;
        } else {
          this.connect_timeout = Math.floor(config.connectionTimeoutMillis / 1e3);
        }
        if (config.keepAlive === false) {
          this.keepalives = 0;
        } else if (config.keepAlive === true) {
          this.keepalives = 1;
        }
        if (typeof config.keepAliveInitialDelayMillis === "number") {
          this.keepalives_idle = Math.floor(config.keepAliveInitialDelayMillis / 1e3);
        }
      }
      getLibpqConnectionString(cb) {
        const params = [];
        add(params, this, "user");
        add(params, this, "password");
        add(params, this, "port");
        add(params, this, "application_name");
        add(params, this, "fallback_application_name");
        add(params, this, "connect_timeout");
        add(params, this, "options");
        const ssl = typeof this.ssl === "object" ? this.ssl : this.ssl ? { sslmode: this.ssl } : {};
        add(params, ssl, "sslmode");
        add(params, ssl, "sslca");
        add(params, ssl, "sslkey");
        add(params, ssl, "sslcert");
        add(params, ssl, "sslrootcert");
        add(params, this, "sslnegotiation");
        if (this.database) {
          params.push("dbname=" + quoteParamValue(this.database));
        }
        if (this.replication) {
          params.push("replication=" + quoteParamValue(this.replication));
        }
        if (this.host) {
          params.push("host=" + quoteParamValue(this.host));
        }
        if (this.isDomainSocket) {
          return cb(null, params.join(" "));
        }
        if (this.client_encoding) {
          params.push("client_encoding=" + quoteParamValue(this.client_encoding));
        }
        dns.lookup(this.host, function(err, address) {
          if (err) return cb(err, null);
          params.push("hostaddr=" + quoteParamValue(address));
          return cb(null, params.join(" "));
        });
      }
    };
    module.exports = ConnectionParameters;
  }
});

// node_modules/pg/lib/result.js
var require_result = __commonJS({
  "node_modules/pg/lib/result.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    var matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;
    var Result2 = class {
      constructor(rowMode, types3) {
        this.command = null;
        this.rowCount = null;
        this.oid = null;
        this.rows = [];
        this.fields = [];
        this._parsers = void 0;
        this._types = types3;
        this.RowCtor = null;
        this.rowAsArray = rowMode === "array";
        if (this.rowAsArray) {
          this.parseRow = this._parseRowAsArray;
        }
        this._prebuiltEmptyResultObject = null;
      }
      // adds a command complete message
      addCommandComplete(msg) {
        let match;
        if (msg.text) {
          match = matchRegexp.exec(msg.text);
        } else {
          match = matchRegexp.exec(msg.command);
        }
        if (match) {
          this.command = match[1];
          if (match[3]) {
            this.oid = parseInt(match[2], 10);
            this.rowCount = parseInt(match[3], 10);
          } else if (match[2]) {
            this.rowCount = parseInt(match[2], 10);
          }
        }
      }
      _parseRowAsArray(rowData) {
        const row = new Array(rowData.length);
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          if (rawValue !== null) {
            row[i] = this._parsers[i](rawValue);
          } else {
            row[i] = null;
          }
        }
        return row;
      }
      parseRow(rowData) {
        const row = { ...this._prebuiltEmptyResultObject };
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          const field = this.fields[i].name;
          if (rawValue !== null) {
            const v = this.fields[i].format === "binary" ? Buffer.from(rawValue) : rawValue;
            row[field] = this._parsers[i](v);
          } else {
            row[field] = null;
          }
        }
        return row;
      }
      addRow(row) {
        this.rows.push(row);
      }
      addFields(fieldDescriptions) {
        this.fields = fieldDescriptions;
        if (this.fields.length) {
          this._parsers = new Array(fieldDescriptions.length);
        }
        const row = /* @__PURE__ */ Object.create(null);
        for (let i = 0; i < fieldDescriptions.length; i++) {
          const desc = fieldDescriptions[i];
          row[desc.name] = null;
          if (this._types) {
            this._parsers[i] = this._types.getTypeParser(desc.dataTypeID, desc.format || "text");
          } else {
            this._parsers[i] = types2.getTypeParser(desc.dataTypeID, desc.format || "text");
          }
        }
        this._prebuiltEmptyResultObject = { ...row };
      }
    };
    module.exports = Result2;
  }
});

// node_modules/pg/lib/query.js
var require_query = __commonJS({
  "node_modules/pg/lib/query.js"(exports, module) {
    "use strict";
    var { EventEmitter } = __require("events");
    var Result2 = require_result();
    var utils = require_utils();
    var Query2 = class extends EventEmitter {
      constructor(config, values, callback) {
        super();
        config = utils.normalizeQueryConfig(config, values, callback);
        this.text = config.text;
        this.values = config.values;
        this.rows = config.rows;
        this.types = config.types;
        this.name = config.name;
        this.queryMode = config.queryMode;
        this.binary = config.binary;
        this.portal = config.portal || "";
        this.callback = config.callback;
        this._rowMode = config.rowMode;
        if (process.domain && config.callback) {
          this.callback = process.domain.bind(config.callback);
        }
        this._result = new Result2(this._rowMode, this.types);
        this._results = this._result;
        this._canceledDueToError = false;
      }
      requiresPreparation() {
        if (this.queryMode === "extended") {
          return true;
        }
        if (this.name) {
          return true;
        }
        if (this.rows) {
          return true;
        }
        if (!this.text) {
          return false;
        }
        if (!this.values) {
          return false;
        }
        return this.values.length > 0;
      }
      _checkForMultirow() {
        if (this._result.command) {
          if (!Array.isArray(this._results)) {
            this._results = [this._result];
          }
          this._result = new Result2(this._rowMode, this._result._types);
          this._results.push(this._result);
        }
      }
      // associates row metadata from the supplied
      // message with this query object
      // metadata used when parsing row results
      handleRowDescription(msg) {
        this._checkForMultirow();
        this._result.addFields(msg.fields);
        this._accumulateRows = this.callback || !this.listeners("row").length;
      }
      handleDataRow(msg) {
        let row;
        if (this._canceledDueToError) {
          return;
        }
        try {
          row = this._result.parseRow(msg.fields);
        } catch (err) {
          this._canceledDueToError = err;
          return;
        }
        this.emit("row", row, this._result);
        if (this._accumulateRows) {
          this._result.addRow(row);
        }
      }
      handleCommandComplete(msg, connection) {
        this._checkForMultirow();
        this._result.addCommandComplete(msg);
        if (this.rows) {
          connection.sync();
        }
      }
      // if a named prepared statement is created with empty query text
      // the backend will send an emptyQuery message but *not* a command complete message
      // since we pipeline sync immediately after execute we don't need to do anything here
      // unless we have rows specified, in which case we did not pipeline the initial sync call
      handleEmptyQuery(connection) {
        if (this.rows) {
          connection.sync();
        }
      }
      handleError(err, connection) {
        if (this._canceledDueToError) {
          err = this._canceledDueToError;
          this._canceledDueToError = false;
        }
        if (this.callback) {
          return this.callback(err);
        }
        this.emit("error", err);
      }
      handleReadyForQuery(con) {
        if (this._canceledDueToError) {
          return this.handleError(this._canceledDueToError, con);
        }
        if (this.callback) {
          try {
            this.callback(null, this._results);
          } catch (err) {
            process.nextTick(() => {
              throw err;
            });
          }
        }
        this.emit("end", this._results);
      }
      submit(connection) {
        if (typeof this.text !== "string" && typeof this.name !== "string") {
          return new Error("A query must have either text or a name. Supplying neither is unsupported.");
        }
        const previous = connection.parsedStatements[this.name];
        if (this.text && previous && this.text !== previous) {
          return new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
        }
        if (this.values && !Array.isArray(this.values)) {
          return new Error("Query values must be an array");
        }
        if (this.requiresPreparation()) {
          connection.stream.cork && connection.stream.cork();
          try {
            this.prepare(connection);
          } finally {
            connection.stream.uncork && connection.stream.uncork();
          }
        } else {
          connection.query(this.text);
        }
        return null;
      }
      hasBeenParsed(connection) {
        return this.name && connection.parsedStatements[this.name];
      }
      handlePortalSuspended(connection) {
        this._getRows(connection, this.rows);
      }
      _getRows(connection, rows) {
        connection.execute({
          portal: this.portal,
          rows
        });
        if (!rows) {
          connection.sync();
        } else {
          connection.flush();
        }
      }
      // http://developer.postgresql.org/pgdocs/postgres/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
      prepare(connection) {
        if (!this.hasBeenParsed(connection)) {
          connection.parse({
            text: this.text,
            name: this.name,
            types: this.types
          });
        }
        try {
          connection.bind({
            portal: this.portal,
            statement: this.name,
            values: this.values,
            binary: this.binary,
            valueMapper: utils.prepareValue
          });
        } catch (err) {
          connection.close({ type: "S", name: this.name });
          connection.sync();
          this.handleError(err, connection);
          return;
        }
        connection.describe({
          type: "P",
          name: this.portal || ""
        });
        this._getRows(connection, this.rows);
      }
      handleCopyInResponse(connection) {
        connection.sendCopyFail("No source stream defined");
      }
      handleCopyData(msg, connection) {
      }
    };
    module.exports = Query2;
  }
});

// node_modules/pg-protocol/dist/messages.js
var require_messages = __commonJS({
  "node_modules/pg-protocol/dist/messages.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoticeMessage = exports.DataRowMessage = exports.CommandCompleteMessage = exports.ReadyForQueryMessage = exports.NotificationResponseMessage = exports.BackendKeyDataMessage = exports.AuthenticationMD5Password = exports.ParameterStatusMessage = exports.ParameterDescriptionMessage = exports.RowDescriptionMessage = exports.Field = exports.CopyResponse = exports.CopyDataMessage = exports.DatabaseError = exports.copyDone = exports.emptyQuery = exports.replicationStart = exports.portalSuspended = exports.noData = exports.closeComplete = exports.bindComplete = exports.parseComplete = void 0;
    exports.parseComplete = {
      name: "parseComplete",
      length: 5
    };
    exports.bindComplete = {
      name: "bindComplete",
      length: 5
    };
    exports.closeComplete = {
      name: "closeComplete",
      length: 5
    };
    exports.noData = {
      name: "noData",
      length: 5
    };
    exports.portalSuspended = {
      name: "portalSuspended",
      length: 5
    };
    exports.replicationStart = {
      name: "replicationStart",
      length: 4
    };
    exports.emptyQuery = {
      name: "emptyQuery",
      length: 4
    };
    exports.copyDone = {
      name: "copyDone",
      length: 4
    };
    var DatabaseError2 = class extends Error {
      constructor(message, length, name) {
        super(message);
        this.length = length;
        this.name = name;
      }
    };
    exports.DatabaseError = DatabaseError2;
    var CopyDataMessage = class {
      constructor(length, chunk) {
        this.length = length;
        this.chunk = chunk;
        this.name = "copyData";
      }
    };
    exports.CopyDataMessage = CopyDataMessage;
    var CopyResponse = class {
      constructor(length, name, binary, columnCount) {
        this.length = length;
        this.name = name;
        this.binary = binary;
        this.columnTypes = new Array(columnCount);
      }
    };
    exports.CopyResponse = CopyResponse;
    var Field = class {
      constructor(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format) {
        this.name = name;
        this.tableID = tableID;
        this.columnID = columnID;
        this.dataTypeID = dataTypeID;
        this.dataTypeSize = dataTypeSize;
        this.dataTypeModifier = dataTypeModifier;
        this.format = format;
      }
    };
    exports.Field = Field;
    var RowDescriptionMessage = class {
      constructor(length, fieldCount) {
        this.length = length;
        this.fieldCount = fieldCount;
        this.name = "rowDescription";
        this.fields = new Array(this.fieldCount);
      }
    };
    exports.RowDescriptionMessage = RowDescriptionMessage;
    var ParameterDescriptionMessage = class {
      constructor(length, parameterCount) {
        this.length = length;
        this.parameterCount = parameterCount;
        this.name = "parameterDescription";
        this.dataTypeIDs = new Array(this.parameterCount);
      }
    };
    exports.ParameterDescriptionMessage = ParameterDescriptionMessage;
    var ParameterStatusMessage = class {
      constructor(length, parameterName, parameterValue) {
        this.length = length;
        this.parameterName = parameterName;
        this.parameterValue = parameterValue;
        this.name = "parameterStatus";
      }
    };
    exports.ParameterStatusMessage = ParameterStatusMessage;
    var AuthenticationMD5Password = class {
      constructor(length, salt) {
        this.length = length;
        this.salt = salt;
        this.name = "authenticationMD5Password";
      }
    };
    exports.AuthenticationMD5Password = AuthenticationMD5Password;
    var BackendKeyDataMessage = class {
      constructor(length, processID, secretKey) {
        this.length = length;
        this.processID = processID;
        this.secretKey = secretKey;
        this.name = "backendKeyData";
      }
    };
    exports.BackendKeyDataMessage = BackendKeyDataMessage;
    var NotificationResponseMessage = class {
      constructor(length, processId, channel, payload) {
        this.length = length;
        this.processId = processId;
        this.channel = channel;
        this.payload = payload;
        this.name = "notification";
      }
    };
    exports.NotificationResponseMessage = NotificationResponseMessage;
    var ReadyForQueryMessage = class {
      constructor(length, status) {
        this.length = length;
        this.status = status;
        this.name = "readyForQuery";
      }
    };
    exports.ReadyForQueryMessage = ReadyForQueryMessage;
    var CommandCompleteMessage = class {
      constructor(length, text) {
        this.length = length;
        this.text = text;
        this.name = "commandComplete";
      }
    };
    exports.CommandCompleteMessage = CommandCompleteMessage;
    var DataRowMessage = class {
      constructor(length, fields) {
        this.length = length;
        this.fields = fields;
        this.name = "dataRow";
        this.fieldCount = fields.length;
      }
    };
    exports.DataRowMessage = DataRowMessage;
    var NoticeMessage = class {
      constructor(length, message) {
        this.length = length;
        this.message = message;
        this.name = "notice";
      }
    };
    exports.NoticeMessage = NoticeMessage;
  }
});

// node_modules/pg-protocol/dist/buffer-writer.js
var require_buffer_writer = __commonJS({
  "node_modules/pg-protocol/dist/buffer-writer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Writer = void 0;
    var Writer = class {
      constructor(size = 256) {
        this.size = size;
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(size);
      }
      ensure(size) {
        const remaining = this.buffer.length - this.offset;
        if (remaining < size) {
          const oldBuffer = this.buffer;
          const newSize = oldBuffer.length + (oldBuffer.length >> 1) + size;
          this.buffer = Buffer.allocUnsafe(newSize);
          oldBuffer.copy(this.buffer);
        }
      }
      addInt32(num) {
        this.ensure(4);
        this.buffer[this.offset++] = num >>> 24 & 255;
        this.buffer[this.offset++] = num >>> 16 & 255;
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addInt16(num) {
        this.ensure(2);
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addCString(string) {
        if (!string) {
          this.ensure(1);
        } else {
          const len = Buffer.byteLength(string);
          this.ensure(len + 1);
          this.buffer.write(string, this.offset, "utf-8");
          this.offset += len;
        }
        this.buffer[this.offset++] = 0;
        return this;
      }
      addString(string = "") {
        const len = Buffer.byteLength(string);
        this.ensure(len);
        this.buffer.write(string, this.offset);
        this.offset += len;
        return this;
      }
      // Write an Int32 byte-length prefix immediately followed by the string's UTF-8
      // bytes. Postgres' Bind wire format prefixes every parameter with its length,
      // and doing it in one method computes Buffer.byteLength ONCE — the previous
      // `addInt32(Buffer.byteLength(s)).addString(s)` pairing scanned the string
      // three times (byteLength for the prefix, byteLength again inside addString,
      // then the encode), which is costly for large text parameters.
      addInt32PrefixedString(string) {
        const len = Buffer.byteLength(string);
        this.ensure(4 + len);
        const buffer = this.buffer;
        let offset = this.offset;
        buffer[offset++] = len >>> 24 & 255;
        buffer[offset++] = len >>> 16 & 255;
        buffer[offset++] = len >>> 8 & 255;
        buffer[offset++] = len >>> 0 & 255;
        buffer.write(string, offset, "utf-8");
        this.offset = offset + len;
        return this;
      }
      add(otherBuffer) {
        this.ensure(otherBuffer.length);
        otherBuffer.copy(this.buffer, this.offset);
        this.offset += otherBuffer.length;
        return this;
      }
      join(code) {
        if (code) {
          this.buffer[this.headerPosition] = code;
          const length = this.offset - (this.headerPosition + 1);
          this.buffer.writeInt32BE(length, this.headerPosition + 1);
        }
        return this.buffer.slice(code ? 0 : 5, this.offset);
      }
      flush(code) {
        const result = this.join(code);
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(this.size);
        return result;
      }
      clear() {
        this.offset = 5;
        this.headerPosition = 0;
      }
    };
    exports.Writer = Writer;
  }
});

// node_modules/pg-protocol/dist/serializer.js
var require_serializer = __commonJS({
  "node_modules/pg-protocol/dist/serializer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serialize = void 0;
    var buffer_writer_1 = require_buffer_writer();
    var writer = new buffer_writer_1.Writer();
    var startup = (opts) => {
      writer.addInt16(3).addInt16(0);
      for (const key of Object.keys(opts)) {
        writer.addCString(key).addCString(opts[key]);
      }
      writer.addCString("client_encoding").addCString("UTF8");
      const bodyBuffer = writer.addCString("").flush();
      const length = bodyBuffer.length + 4;
      return new buffer_writer_1.Writer().addInt32(length).add(bodyBuffer).flush();
    };
    var requestSsl = () => {
      const response = Buffer.allocUnsafe(8);
      response.writeInt32BE(8, 0);
      response.writeInt32BE(80877103, 4);
      return response;
    };
    var password = (password2) => {
      return writer.addCString(password2).flush(
        112
        /* code.startup */
      );
    };
    var sendSASLInitialResponseMessage = function(mechanism, initialResponse) {
      writer.addCString(mechanism).addInt32PrefixedString(initialResponse);
      return writer.flush(
        112
        /* code.startup */
      );
    };
    var sendSCRAMClientFinalMessage = function(additionalData) {
      return writer.addString(additionalData).flush(
        112
        /* code.startup */
      );
    };
    var query = (text) => {
      return writer.addCString(text).flush(
        81
        /* code.query */
      );
    };
    var emptyArray = [];
    var parse = (query2) => {
      const name = query2.name || "";
      if (name.length > 63) {
        console.error("Warning! Postgres only supports 63 characters for query names.");
        console.error("You supplied %s (%s)", name, name.length);
        console.error("This can cause conflicts and silent errors executing queries");
      }
      const types2 = query2.types || emptyArray;
      const len = types2.length;
      const buffer = writer.addCString(name).addCString(query2.text).addInt16(len);
      for (let i = 0; i < len; i++) {
        buffer.addInt32(types2[i]);
      }
      return writer.flush(
        80
        /* code.parse */
      );
    };
    var paramWriter = new buffer_writer_1.Writer();
    var writeValues = function(values, valueMapper) {
      for (let i = 0; i < values.length; i++) {
        const mappedVal = valueMapper ? valueMapper(values[i], i) : values[i];
        if (mappedVal == null) {
          writer.addInt16(
            0
            /* ParamType.STRING */
          );
          paramWriter.addInt32(-1);
        } else if (mappedVal instanceof Buffer) {
          writer.addInt16(
            1
            /* ParamType.BINARY */
          );
          paramWriter.addInt32(mappedVal.length);
          paramWriter.add(mappedVal);
        } else {
          writer.addInt16(
            0
            /* ParamType.STRING */
          );
          paramWriter.addInt32PrefixedString(mappedVal);
        }
      }
    };
    var bind = (config = {}) => {
      const portal = config.portal || "";
      const statement = config.statement || "";
      const binary = config.binary || false;
      const values = config.values || emptyArray;
      const len = values.length;
      writer.addCString(portal).addCString(statement);
      writer.addInt16(len);
      try {
        writeValues(values, config.valueMapper);
      } catch (err) {
        writer.clear();
        paramWriter.clear();
        throw err;
      }
      writer.addInt16(len);
      writer.add(paramWriter.flush());
      writer.addInt16(1);
      writer.addInt16(
        binary ? 1 : 0
        /* ParamType.STRING */
      );
      return writer.flush(
        66
        /* code.bind */
      );
    };
    var emptyExecute = Buffer.from([69, 0, 0, 0, 9, 0, 0, 0, 0, 0]);
    var execute = (config) => {
      if (!config || !config.portal && !config.rows) {
        return emptyExecute;
      }
      const portal = config.portal || "";
      const rows = config.rows || 0;
      const portalLength = Buffer.byteLength(portal);
      const len = 4 + portalLength + 1 + 4;
      const buff = Buffer.allocUnsafe(1 + len);
      buff[0] = 69;
      buff.writeInt32BE(len, 1);
      buff.write(portal, 5, "utf-8");
      buff[portalLength + 5] = 0;
      buff.writeUInt32BE(rows, buff.length - 4);
      return buff;
    };
    var cancel = (processID, secretKey) => {
      const buffer = Buffer.allocUnsafe(16);
      buffer.writeInt32BE(16, 0);
      buffer.writeInt16BE(1234, 4);
      buffer.writeInt16BE(5678, 6);
      buffer.writeInt32BE(processID, 8);
      buffer.writeInt32BE(secretKey, 12);
      return buffer;
    };
    var cstringMessage = (code, string) => {
      const stringLen = Buffer.byteLength(string);
      const len = 4 + stringLen + 1;
      const buffer = Buffer.allocUnsafe(1 + len);
      buffer[0] = code;
      buffer.writeInt32BE(len, 1);
      buffer.write(string, 5, "utf-8");
      buffer[len] = 0;
      return buffer;
    };
    var emptyDescribePortal = writer.addCString("P").flush(
      68
      /* code.describe */
    );
    var emptyDescribeStatement = writer.addCString("S").flush(
      68
      /* code.describe */
    );
    var describe = (msg) => {
      return msg.name ? cstringMessage(68, `${msg.type}${msg.name || ""}`) : msg.type === "P" ? emptyDescribePortal : emptyDescribeStatement;
    };
    var close = (msg) => {
      const text = `${msg.type}${msg.name || ""}`;
      return cstringMessage(67, text);
    };
    var copyData = (chunk) => {
      return writer.add(chunk).flush(
        100
        /* code.copyFromChunk */
      );
    };
    var copyFail = (message) => {
      return cstringMessage(102, message);
    };
    var codeOnlyBuffer = (code) => Buffer.from([code, 0, 0, 0, 4]);
    var flushBuffer = codeOnlyBuffer(
      72
      /* code.flush */
    );
    var syncBuffer = codeOnlyBuffer(
      83
      /* code.sync */
    );
    var endBuffer = codeOnlyBuffer(
      88
      /* code.end */
    );
    var copyDoneBuffer = codeOnlyBuffer(
      99
      /* code.copyDone */
    );
    var serialize = {
      startup,
      password,
      requestSsl,
      sendSASLInitialResponseMessage,
      sendSCRAMClientFinalMessage,
      query,
      parse,
      bind,
      execute,
      describe,
      close,
      flush: () => flushBuffer,
      sync: () => syncBuffer,
      end: () => endBuffer,
      copyData,
      copyDone: () => copyDoneBuffer,
      copyFail,
      cancel
    };
    exports.serialize = serialize;
  }
});

// node_modules/pg-protocol/dist/buffer-reader.js
var require_buffer_reader = __commonJS({
  "node_modules/pg-protocol/dist/buffer-reader.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BufferReader = void 0;
    var BufferReader = class {
      constructor(offset = 0) {
        this.offset = offset;
        this.buffer = Buffer.allocUnsafe(0);
        this.encoding = "utf-8";
      }
      setBuffer(offset, buffer) {
        this.offset = offset;
        this.buffer = buffer;
      }
      int16() {
        const result = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return result;
      }
      byte() {
        const result = this.buffer[this.offset];
        this.offset++;
        return result;
      }
      int32() {
        const result = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      uint32() {
        const result = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      string(length) {
        const result = this.buffer.toString(this.encoding, this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
      cstring() {
        const start = this.offset;
        let end = start;
        while (this.buffer[end++]) {
        }
        this.offset = end;
        return this.buffer.toString(this.encoding, start, end - 1);
      }
      bytes(length) {
        const result = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
    };
    exports.BufferReader = BufferReader;
  }
});

// node_modules/pg-protocol/dist/parser.js
var require_parser = __commonJS({
  "node_modules/pg-protocol/dist/parser.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Parser = void 0;
    var messages_1 = require_messages();
    var buffer_reader_1 = require_buffer_reader();
    var CODE_LENGTH = 1;
    var LEN_LENGTH = 4;
    var HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;
    var LATEINIT_LENGTH = -1;
    var emptyBuffer = Buffer.allocUnsafe(0);
    var Parser = class {
      constructor(opts) {
        this.buffer = emptyBuffer;
        this.bufferLength = 0;
        this.bufferOffset = 0;
        this.reader = new buffer_reader_1.BufferReader();
        if ((opts === null || opts === void 0 ? void 0 : opts.mode) === "binary") {
          throw new Error("Binary mode not supported yet");
        }
        this.mode = (opts === null || opts === void 0 ? void 0 : opts.mode) || "text";
      }
      parse(buffer, callback) {
        this.mergeBuffer(buffer);
        const bufferFullLength = this.bufferOffset + this.bufferLength;
        let offset = this.bufferOffset;
        while (offset + HEADER_LENGTH <= bufferFullLength) {
          const code = this.buffer[offset];
          const length = this.buffer.readUInt32BE(offset + CODE_LENGTH);
          const fullMessageLength = CODE_LENGTH + length;
          if (fullMessageLength + offset <= bufferFullLength) {
            const message = this.handlePacket(offset + HEADER_LENGTH, code, length, this.buffer);
            callback(message);
            offset += fullMessageLength;
          } else {
            break;
          }
        }
        if (offset === bufferFullLength) {
          this.buffer = emptyBuffer;
          this.bufferLength = 0;
          this.bufferOffset = 0;
        } else {
          this.bufferLength = bufferFullLength - offset;
          this.bufferOffset = offset;
        }
      }
      mergeBuffer(buffer) {
        if (this.bufferLength > 0) {
          const newLength = this.bufferLength + buffer.byteLength;
          const newFullLength = newLength + this.bufferOffset;
          if (newFullLength > this.buffer.byteLength) {
            let newBuffer;
            if (newLength <= this.buffer.byteLength && this.bufferOffset >= this.bufferLength) {
              newBuffer = this.buffer;
            } else {
              let newBufferLength = this.buffer.byteLength * 2;
              while (newLength >= newBufferLength) {
                newBufferLength *= 2;
              }
              newBuffer = Buffer.allocUnsafe(newBufferLength);
            }
            this.buffer.copy(newBuffer, 0, this.bufferOffset, this.bufferOffset + this.bufferLength);
            this.buffer = newBuffer;
            this.bufferOffset = 0;
          }
          buffer.copy(this.buffer, this.bufferOffset + this.bufferLength);
          this.bufferLength = newLength;
        } else {
          this.buffer = buffer;
          this.bufferOffset = 0;
          this.bufferLength = buffer.byteLength;
        }
      }
      handlePacket(offset, code, length, bytes) {
        const { reader } = this;
        reader.setBuffer(offset, bytes);
        let message;
        switch (code) {
          case 50:
            message = messages_1.bindComplete;
            break;
          case 49:
            message = messages_1.parseComplete;
            break;
          case 51:
            message = messages_1.closeComplete;
            break;
          case 110:
            message = messages_1.noData;
            break;
          case 115:
            message = messages_1.portalSuspended;
            break;
          case 99:
            message = messages_1.copyDone;
            break;
          case 87:
            message = messages_1.replicationStart;
            break;
          case 73:
            message = messages_1.emptyQuery;
            break;
          case 68:
            message = parseDataRowMessage(reader);
            break;
          case 67:
            message = parseCommandCompleteMessage(reader);
            break;
          case 90:
            message = parseReadyForQueryMessage(reader);
            break;
          case 65:
            message = parseNotificationMessage(reader);
            break;
          case 82:
            message = parseAuthenticationResponse(reader, length);
            break;
          case 83:
            message = parseParameterStatusMessage(reader);
            break;
          case 75:
            message = parseBackendKeyData(reader);
            break;
          case 69:
            message = parseErrorMessage(reader, "error");
            break;
          case 78:
            message = parseErrorMessage(reader, "notice");
            break;
          case 84:
            message = parseRowDescriptionMessage(reader);
            break;
          case 116:
            message = parseParameterDescriptionMessage(reader);
            break;
          case 71:
            message = parseCopyInMessage(reader);
            break;
          case 72:
            message = parseCopyOutMessage(reader);
            break;
          case 100:
            message = parseCopyData(reader, length);
            break;
          default:
            return new messages_1.DatabaseError("received invalid response: " + code.toString(16), length, "error");
        }
        reader.setBuffer(0, emptyBuffer);
        message.length = length;
        return message;
      }
    };
    exports.Parser = Parser;
    var parseReadyForQueryMessage = (reader) => {
      const status = reader.string(1);
      return new messages_1.ReadyForQueryMessage(LATEINIT_LENGTH, status);
    };
    var parseCommandCompleteMessage = (reader) => {
      const text = reader.cstring();
      return new messages_1.CommandCompleteMessage(LATEINIT_LENGTH, text);
    };
    var parseCopyData = (reader, length) => {
      const chunk = reader.bytes(length - 4);
      return new messages_1.CopyDataMessage(LATEINIT_LENGTH, chunk);
    };
    var parseCopyInMessage = (reader) => parseCopyMessage(reader, "copyInResponse");
    var parseCopyOutMessage = (reader) => parseCopyMessage(reader, "copyOutResponse");
    var parseCopyMessage = (reader, messageName) => {
      const isBinary = reader.byte() !== 0;
      const columnCount = reader.int16();
      const message = new messages_1.CopyResponse(LATEINIT_LENGTH, messageName, isBinary, columnCount);
      for (let i = 0; i < columnCount; i++) {
        message.columnTypes[i] = reader.int16();
      }
      return message;
    };
    var parseNotificationMessage = (reader) => {
      const processId = reader.int32();
      const channel = reader.cstring();
      const payload = reader.cstring();
      return new messages_1.NotificationResponseMessage(LATEINIT_LENGTH, processId, channel, payload);
    };
    var parseRowDescriptionMessage = (reader) => {
      const fieldCount = reader.int16();
      const message = new messages_1.RowDescriptionMessage(LATEINIT_LENGTH, fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        message.fields[i] = parseField(reader);
      }
      return message;
    };
    var parseField = (reader) => {
      const name = reader.cstring();
      const tableID = reader.uint32();
      const columnID = reader.int16();
      const dataTypeID = reader.uint32();
      const dataTypeSize = reader.int16();
      const dataTypeModifier = reader.int32();
      const mode = reader.int16() === 0 ? "text" : "binary";
      return new messages_1.Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
    };
    var parseParameterDescriptionMessage = (reader) => {
      const parameterCount = reader.int16();
      const message = new messages_1.ParameterDescriptionMessage(LATEINIT_LENGTH, parameterCount);
      for (let i = 0; i < parameterCount; i++) {
        message.dataTypeIDs[i] = reader.int32();
      }
      return message;
    };
    var parseDataRowMessage = (reader) => {
      const fieldCount = reader.int16();
      const fields = new Array(fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        const len = reader.int32();
        fields[i] = len === -1 ? null : reader.string(len);
      }
      return new messages_1.DataRowMessage(LATEINIT_LENGTH, fields);
    };
    var parseParameterStatusMessage = (reader) => {
      const name = reader.cstring();
      const value = reader.cstring();
      return new messages_1.ParameterStatusMessage(LATEINIT_LENGTH, name, value);
    };
    var parseBackendKeyData = (reader) => {
      const processID = reader.int32();
      const secretKey = reader.int32();
      return new messages_1.BackendKeyDataMessage(LATEINIT_LENGTH, processID, secretKey);
    };
    var parseAuthenticationResponse = (reader, length) => {
      const code = reader.int32();
      const message = {
        name: "authenticationOk",
        length
      };
      switch (code) {
        case 0:
          break;
        case 3:
          if (message.length === 8) {
            message.name = "authenticationCleartextPassword";
          }
          break;
        case 5:
          if (message.length === 12) {
            message.name = "authenticationMD5Password";
            const salt = reader.bytes(4);
            return new messages_1.AuthenticationMD5Password(LATEINIT_LENGTH, salt);
          }
          break;
        case 10:
          {
            message.name = "authenticationSASL";
            message.mechanisms = [];
            let mechanism;
            do {
              mechanism = reader.cstring();
              if (mechanism) {
                message.mechanisms.push(mechanism);
              }
            } while (mechanism);
          }
          break;
        case 11:
          message.name = "authenticationSASLContinue";
          message.data = reader.string(length - 8);
          break;
        case 12:
          message.name = "authenticationSASLFinal";
          message.data = reader.string(length - 8);
          break;
        default:
          throw new Error("Unknown authenticationOk message type " + code);
      }
      return message;
    };
    var parseErrorMessage = (reader, name) => {
      const fields = {};
      let fieldType = reader.string(1);
      while (fieldType !== "\0") {
        fields[fieldType] = reader.cstring();
        fieldType = reader.string(1);
      }
      const messageValue = fields.M;
      const message = name === "notice" ? new messages_1.NoticeMessage(LATEINIT_LENGTH, messageValue) : new messages_1.DatabaseError(messageValue, LATEINIT_LENGTH, name);
      message.severity = fields.S;
      message.code = fields.C;
      message.detail = fields.D;
      message.hint = fields.H;
      message.position = fields.P;
      message.internalPosition = fields.p;
      message.internalQuery = fields.q;
      message.where = fields.W;
      message.schema = fields.s;
      message.table = fields.t;
      message.column = fields.c;
      message.dataType = fields.d;
      message.constraint = fields.n;
      message.file = fields.F;
      message.line = fields.L;
      message.routine = fields.R;
      return message;
    };
  }
});

// node_modules/pg-protocol/dist/index.js
var require_dist = __commonJS({
  "node_modules/pg-protocol/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DatabaseError = exports.serialize = void 0;
    exports.parse = parse;
    var messages_1 = require_messages();
    Object.defineProperty(exports, "DatabaseError", { enumerable: true, get: function() {
      return messages_1.DatabaseError;
    } });
    var serializer_1 = require_serializer();
    Object.defineProperty(exports, "serialize", { enumerable: true, get: function() {
      return serializer_1.serialize;
    } });
    var parser_1 = require_parser();
    function parse(stream, callback) {
      const parser = new parser_1.Parser();
      stream.on("data", (buffer) => parser.parse(buffer, callback));
      return new Promise((resolve) => stream.on("end", () => resolve()));
    }
  }
});

// node_modules/pg-cloudflare/dist/empty.js
var require_empty = __commonJS({
  "node_modules/pg-cloudflare/dist/empty.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = {};
  }
});

// node_modules/pg/lib/stream.js
var require_stream = __commonJS({
  "node_modules/pg/lib/stream.js"(exports, module) {
    var { getStream, getSecureStream } = getStreamFuncs();
    module.exports = {
      /**
       * Get a socket stream compatible with the current runtime environment.
       * @returns {Duplex}
       */
      getStream,
      /**
       * Get a TLS secured socket, compatible with the current environment,
       * using the socket and other settings given in `options`.
       * @returns {Duplex}
       */
      getSecureStream
    };
    function getNodejsStreamFuncs() {
      function getStream2(ssl) {
        const net = __require("net");
        return new net.Socket();
      }
      function getSecureStream2(options) {
        const tls = __require("tls");
        return tls.connect(options);
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function getCloudflareStreamFuncs() {
      function getStream2(ssl) {
        const { CloudflareSocket } = require_empty();
        return new CloudflareSocket(ssl);
      }
      function getSecureStream2(options) {
        options.socket.startTls(options);
        return options.socket;
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function isCloudflareRuntime() {
      if (typeof navigator === "object" && navigator !== null && typeof navigator.userAgent === "string") {
        return navigator.userAgent === "Cloudflare-Workers";
      }
      if (typeof Response === "function") {
        const resp = new Response(null, { cf: { thing: true } });
        if (typeof resp.cf === "object" && resp.cf !== null && resp.cf.thing) {
          return true;
        }
      }
      return false;
    }
    function getStreamFuncs() {
      if (isCloudflareRuntime()) {
        return getCloudflareStreamFuncs();
      }
      return getNodejsStreamFuncs();
    }
  }
});

// node_modules/pg/lib/connection.js
var require_connection = __commonJS({
  "node_modules/pg/lib/connection.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var { parse, serialize } = require_dist();
    var stream = require_stream();
    var { getStream } = stream;
    var flushBuffer = serialize.flush();
    var syncBuffer = serialize.sync();
    var endBuffer = serialize.end();
    var Connection2 = class extends EventEmitter {
      constructor(config) {
        super();
        config = config || {};
        this.stream = config.stream || getStream(config.ssl);
        if (typeof this.stream === "function") {
          this.stream = this.stream(config);
        }
        this._keepAlive = config.keepAlive;
        this._keepAliveInitialDelayMillis = config.keepAliveInitialDelayMillis;
        this.parsedStatements = {};
        this.ssl = config.ssl || false;
        this.sslNegotiation = config.sslNegotiation || "postgres";
        this._ending = false;
        this._emitMessage = false;
        const self = this;
        this.on("newListener", function(eventName) {
          if (eventName === "message") {
            self._emitMessage = true;
          }
        });
      }
      connect(port, host) {
        const self = this;
        this._connecting = true;
        this.stream.setNoDelay(true);
        this.stream.connect(port, host);
        this.stream.once("connect", function() {
          if (self._keepAlive) {
            self.stream.setKeepAlive(true, self._keepAliveInitialDelayMillis);
          }
          self.emit("connect");
        });
        const reportStreamError = function(error) {
          if (self._ending && (error.code === "ECONNRESET" || error.code === "EPIPE")) {
            return;
          }
          self.emit("error", error);
        };
        this.stream.on("error", reportStreamError);
        this.stream.on("close", function() {
          self.emit("end");
        });
        if (!this.ssl) {
          return this.attachListeners(this.stream);
        }
        if (this.sslNegotiation === "direct") {
          return this.stream.once("connect", function() {
            self.upgradeToSSL(host, reportStreamError);
          });
        }
        this.stream.once("data", function(buffer) {
          const responseCode = buffer.toString("utf8");
          switch (responseCode) {
            case "S":
              break;
            case "N":
              self.stream.end();
              return self.emit("error", new Error("The server does not support SSL connections"));
            default:
              self.stream.end();
              return self.emit("error", new Error("There was an error establishing an SSL connection"));
          }
          self.upgradeToSSL(host, reportStreamError);
        });
      }
      upgradeToSSL(host, reportStreamError) {
        const self = this;
        const options = {
          socket: self.stream
        };
        if (self.ssl !== true) {
          Object.assign(options, self.ssl);
          if ("key" in self.ssl) {
            options.key = self.ssl.key;
          }
        }
        if (self.sslNegotiation === "direct") {
          options.ALPNProtocols = ["postgresql"];
        }
        const net = __require("net");
        if (net.isIP && net.isIP(host) === 0) {
          options.servername = host;
        }
        try {
          self.stream = stream.getSecureStream(options);
        } catch (err) {
          return self.emit("error", err);
        }
        self.attachListeners(self.stream);
        self.stream.on("error", reportStreamError);
        self.emit("sslconnect");
      }
      attachListeners(stream2) {
        parse(stream2, (msg) => {
          const eventName = msg.name === "error" ? "errorMessage" : msg.name;
          if (this._emitMessage) {
            this.emit("message", msg);
          }
          this.emit(eventName, msg);
        });
      }
      requestSsl() {
        this.stream.write(serialize.requestSsl());
      }
      startup(config) {
        this.stream.write(serialize.startup(config));
      }
      cancel(processID, secretKey) {
        this._send(serialize.cancel(processID, secretKey));
      }
      password(password) {
        this._send(serialize.password(password));
      }
      sendSASLInitialResponseMessage(mechanism, initialResponse) {
        this._send(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse));
      }
      sendSCRAMClientFinalMessage(additionalData) {
        this._send(serialize.sendSCRAMClientFinalMessage(additionalData));
      }
      _send(buffer) {
        if (!this.stream.writable) {
          return false;
        }
        return this.stream.write(buffer);
      }
      query(text) {
        this._send(serialize.query(text));
      }
      // send parse message
      parse(query) {
        this._send(serialize.parse(query));
      }
      // send bind message
      bind(config) {
        this._send(serialize.bind(config));
      }
      // send execute message
      execute(config) {
        this._send(serialize.execute(config));
      }
      flush() {
        if (this.stream.writable) {
          this.stream.write(flushBuffer);
        }
      }
      sync() {
        this._ending = true;
        this._send(syncBuffer);
      }
      ref() {
        this.stream.ref();
      }
      unref() {
        this.stream.unref();
      }
      end() {
        this._ending = true;
        if (!this._connecting || !this.stream.writable) {
          this.stream.end();
          return;
        }
        return this.stream.write(endBuffer, () => {
          this.stream.end();
        });
      }
      close(msg) {
        this._send(serialize.close(msg));
      }
      describe(msg) {
        this._send(serialize.describe(msg));
      }
      sendCopyFromChunk(chunk) {
        this._send(serialize.copyData(chunk));
      }
      endCopyFrom() {
        this._send(serialize.copyDone());
      }
      sendCopyFail(msg) {
        this._send(serialize.copyFail(msg));
      }
    };
    module.exports = Connection2;
  }
});

// node_modules/split2/index.js
var require_split2 = __commonJS({
  "node_modules/split2/index.js"(exports, module) {
    "use strict";
    var { Transform } = __require("stream");
    var { StringDecoder } = __require("string_decoder");
    var kLast = Symbol("last");
    var kDecoder = Symbol("decoder");
    function transform(chunk, enc, cb) {
      let list;
      if (this.overflow) {
        const buf = this[kDecoder].write(chunk);
        list = buf.split(this.matcher);
        if (list.length === 1) return cb();
        list.shift();
        this.overflow = false;
      } else {
        this[kLast] += this[kDecoder].write(chunk);
        list = this[kLast].split(this.matcher);
      }
      this[kLast] = list.pop();
      for (let i = 0; i < list.length; i++) {
        try {
          push(this, this.mapper(list[i]));
        } catch (error) {
          return cb(error);
        }
      }
      this.overflow = this[kLast].length > this.maxLength;
      if (this.overflow && !this.skipOverflow) {
        cb(new Error("maximum buffer reached"));
        return;
      }
      cb();
    }
    function flush(cb) {
      this[kLast] += this[kDecoder].end();
      if (this[kLast]) {
        try {
          push(this, this.mapper(this[kLast]));
        } catch (error) {
          return cb(error);
        }
      }
      cb();
    }
    function push(self, val) {
      if (val !== void 0) {
        self.push(val);
      }
    }
    function noop(incoming) {
      return incoming;
    }
    function split(matcher, mapper, options) {
      matcher = matcher || /\r?\n/;
      mapper = mapper || noop;
      options = options || {};
      switch (arguments.length) {
        case 1:
          if (typeof matcher === "function") {
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof matcher === "object" && !(matcher instanceof RegExp) && !matcher[Symbol.split]) {
            options = matcher;
            matcher = /\r?\n/;
          }
          break;
        case 2:
          if (typeof matcher === "function") {
            options = mapper;
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof mapper === "object") {
            options = mapper;
            mapper = noop;
          }
      }
      options = Object.assign({}, options);
      options.autoDestroy = true;
      options.transform = transform;
      options.flush = flush;
      options.readableObjectMode = true;
      const stream = new Transform(options);
      stream[kLast] = "";
      stream[kDecoder] = new StringDecoder("utf8");
      stream.matcher = matcher;
      stream.mapper = mapper;
      stream.maxLength = options.maxLength;
      stream.skipOverflow = options.skipOverflow || false;
      stream.overflow = false;
      stream._destroy = function(err, cb) {
        this._writableState.errorEmitted = false;
        cb(err);
      };
      return stream;
    }
    module.exports = split;
  }
});

// node_modules/pgpass/lib/helper.js
var require_helper = __commonJS({
  "node_modules/pgpass/lib/helper.js"(exports, module) {
    "use strict";
    var path9 = __require("path");
    var Stream = __require("stream").Stream;
    var split = require_split2();
    var util = __require("util");
    var defaultPort = 5432;
    var isWin = process.platform === "win32";
    var warnStream = process.stderr;
    var S_IRWXG = 56;
    var S_IRWXO = 7;
    var S_IFMT = 61440;
    var S_IFREG = 32768;
    function isRegFile(mode) {
      return (mode & S_IFMT) == S_IFREG;
    }
    var fieldNames = ["host", "port", "database", "user", "password"];
    var nrOfFields = fieldNames.length;
    var passKey = fieldNames[nrOfFields - 1];
    function warn() {
      var isWritable = warnStream instanceof Stream && true === warnStream.writable;
      if (isWritable) {
        var args = Array.prototype.slice.call(arguments).concat("\n");
        warnStream.write(util.format.apply(util, args));
      }
    }
    Object.defineProperty(module.exports, "isWin", {
      get: function() {
        return isWin;
      },
      set: function(val) {
        isWin = val;
      }
    });
    module.exports.warnTo = function(stream) {
      var old = warnStream;
      warnStream = stream;
      return old;
    };
    module.exports.getFileName = function(rawEnv) {
      var env = rawEnv || process.env;
      var file = env.PGPASSFILE || (isWin ? path9.join(env.APPDATA || "./", "postgresql", "pgpass.conf") : path9.join(env.HOME || "./", ".pgpass"));
      return file;
    };
    module.exports.usePgPass = function(stats, fname) {
      if (Object.prototype.hasOwnProperty.call(process.env, "PGPASSWORD")) {
        return false;
      }
      if (isWin) {
        return true;
      }
      fname = fname || "<unkn>";
      if (!isRegFile(stats.mode)) {
        warn('WARNING: password file "%s" is not a plain file', fname);
        return false;
      }
      if (stats.mode & (S_IRWXG | S_IRWXO)) {
        warn('WARNING: password file "%s" has group or world access; permissions should be u=rw (0600) or less', fname);
        return false;
      }
      return true;
    };
    var matcher = module.exports.match = function(connInfo, entry) {
      return fieldNames.slice(0, -1).reduce(function(prev, field, idx) {
        if (idx == 1) {
          if (Number(connInfo[field] || defaultPort) === Number(entry[field])) {
            return prev && true;
          }
        }
        return prev && (entry[field] === "*" || entry[field] === connInfo[field]);
      }, true);
    };
    module.exports.getPassword = function(connInfo, stream, cb) {
      var pass;
      var lineStream = stream.pipe(split());
      function onLine(line) {
        var entry = parseLine(line);
        if (entry && isValidEntry(entry) && matcher(connInfo, entry)) {
          pass = entry[passKey];
          lineStream.end();
        }
      }
      var onEnd = function() {
        stream.destroy();
        cb(pass);
      };
      var onErr = function(err) {
        stream.destroy();
        warn("WARNING: error on reading file: %s", err);
        cb(void 0);
      };
      stream.on("error", onErr);
      lineStream.on("data", onLine).on("end", onEnd).on("error", onErr);
    };
    var parseLine = module.exports.parseLine = function(line) {
      if (line.length < 11 || line.match(/^\s+#/)) {
        return null;
      }
      var curChar = "";
      var prevChar = "";
      var fieldIdx = 0;
      var startIdx = 0;
      var endIdx = 0;
      var obj = {};
      var isLastField = false;
      var addToObj = function(idx, i0, i1) {
        var field = line.substring(i0, i1);
        if (!Object.hasOwnProperty.call(process.env, "PGPASS_NO_DEESCAPE")) {
          field = field.replace(/\\([:\\])/g, "$1");
        }
        obj[fieldNames[idx]] = field;
      };
      for (var i = 0; i < line.length - 1; i += 1) {
        curChar = line.charAt(i + 1);
        prevChar = line.charAt(i);
        isLastField = fieldIdx == nrOfFields - 1;
        if (isLastField) {
          addToObj(fieldIdx, startIdx);
          break;
        }
        if (i >= 0 && curChar == ":" && prevChar !== "\\") {
          addToObj(fieldIdx, startIdx, i + 1);
          startIdx = i + 2;
          fieldIdx += 1;
        }
      }
      obj = Object.keys(obj).length === nrOfFields ? obj : null;
      return obj;
    };
    var isValidEntry = module.exports.isValidEntry = function(entry) {
      var rules = {
        // host
        0: function(x) {
          return x.length > 0;
        },
        // port
        1: function(x) {
          if (x === "*") {
            return true;
          }
          x = Number(x);
          return isFinite(x) && x > 0 && x < 9007199254740992 && Math.floor(x) === x;
        },
        // database
        2: function(x) {
          return x.length > 0;
        },
        // username
        3: function(x) {
          return x.length > 0;
        },
        // password
        4: function(x) {
          return x.length > 0;
        }
      };
      for (var idx = 0; idx < fieldNames.length; idx += 1) {
        var rule = rules[idx];
        var value = entry[fieldNames[idx]] || "";
        var res = rule(value);
        if (!res) {
          return false;
        }
      }
      return true;
    };
  }
});

// node_modules/pgpass/lib/index.js
var require_lib = __commonJS({
  "node_modules/pgpass/lib/index.js"(exports, module) {
    "use strict";
    var path9 = __require("path");
    var fs = __require("fs");
    var helper = require_helper();
    module.exports = function(connInfo, cb) {
      var file = helper.getFileName();
      fs.stat(file, function(err, stat) {
        if (err || !helper.usePgPass(stat, file)) {
          return cb(void 0);
        }
        var st = fs.createReadStream(file);
        helper.getPassword(connInfo, st, cb);
      });
    };
    module.exports.warnTo = helper.warnTo;
  }
});

// node_modules/pg/lib/client.js
var require_client = __commonJS({
  "node_modules/pg/lib/client.js"(exports, module) {
    var EventEmitter = __require("events").EventEmitter;
    var utils = require_utils();
    var nodeUtils = __require("util");
    var sasl = require_sasl();
    var TypeOverrides2 = require_type_overrides();
    var ConnectionParameters = require_connection_parameters();
    var Query2 = require_query();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var crypto = require_utils2();
    var activeQueryDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.activeQuery is deprecated and will be removed in pg@9.0"
    );
    var queryQueueDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.queryQueue is deprecated and will be removed in pg@9.0."
    );
    var pgPassDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "pgpass support is deprecated and will be removed in pg@9.0. You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code."
    );
    var byoPromiseDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0."
    );
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    function coerceNumberOrDefault(value, defaultValue) {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : defaultValue;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : defaultValue;
      }
      return defaultValue;
    }
    var Client2 = class extends EventEmitter {
      constructor(config) {
        super();
        this.connectionParameters = new ConnectionParameters(config);
        this.user = this.connectionParameters.user;
        this.database = this.connectionParameters.database;
        this.port = this.connectionParameters.port;
        this.host = this.connectionParameters.host;
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: this.connectionParameters.password
        });
        this.replication = this.connectionParameters.replication;
        const c = config || {};
        if (c.Promise) {
          byoPromiseDeprecationNotice();
        }
        this._Promise = c.Promise || global.Promise;
        this._types = new TypeOverrides2(c.types);
        this._ending = false;
        this._ended = false;
        this._connecting = false;
        this._connected = false;
        this._connectionError = false;
        this._queryable = true;
        this._activeQuery = null;
        this._txStatus = null;
        this.enableChannelBinding = Boolean(c.enableChannelBinding);
        this.scramMaxIterations = coerceNumberOrDefault(c.scramMaxIterations, sasl.DEFAULT_MAX_SCRAM_ITERATIONS);
        this.connection = c.connection || new Connection2({
          stream: c.stream,
          ssl: this.connectionParameters.ssl,
          sslNegotiation: this.connectionParameters.sslnegotiation,
          keepAlive: c.keepAlive || false,
          keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis || 0,
          encoding: this.connectionParameters.client_encoding || "utf8"
        });
        this._queryQueue = [];
        this.binary = c.binary || defaults2.binary;
        this.processID = null;
        this.secretKey = null;
        this.ssl = this.connectionParameters.ssl || false;
        this.sslNegotiation = this.connectionParameters.sslnegotiation || "postgres";
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this._connectionTimeoutMillis = c.connectionTimeoutMillis || 0;
      }
      get activeQuery() {
        activeQueryDeprecationNotice();
        return this._activeQuery;
      }
      set activeQuery(val) {
        activeQueryDeprecationNotice();
        this._activeQuery = val;
      }
      _getActiveQuery() {
        return this._activeQuery;
      }
      _errorAllQueries(err) {
        const enqueueError = (query) => {
          process.nextTick(() => {
            query.handleError(err, this.connection);
          });
        };
        const activeQuery = this._getActiveQuery();
        if (activeQuery) {
          enqueueError(activeQuery);
          this._activeQuery = null;
        }
        this._queryQueue.forEach(enqueueError);
        this._queryQueue.length = 0;
      }
      _connect(callback) {
        const self = this;
        const con = this.connection;
        this._connectionCallback = callback;
        if (this._connecting || this._connected) {
          const err = new Error("Client has already been connected. You cannot reuse a client.");
          process.nextTick(() => {
            callback(err);
          });
          return;
        }
        this._connecting = true;
        if (this._connectionTimeoutMillis > 0) {
          this.connectionTimeoutHandle = setTimeout(() => {
            con._ending = true;
            con.stream.destroy(new Error("timeout expired"));
          }, this._connectionTimeoutMillis);
          if (this.connectionTimeoutHandle.unref) {
            this.connectionTimeoutHandle.unref();
          }
        }
        if (this.host && this.host.indexOf("/") === 0) {
          con.connect(this.host + "/.s.PGSQL." + this.port);
        } else {
          con.connect(this.port, this.host);
        }
        con.on("connect", function() {
          if (self.ssl) {
            if (self.sslNegotiation !== "direct") {
              con.requestSsl();
            }
          } else {
            con.startup(self.getStartupConf());
          }
        });
        con.on("sslconnect", function() {
          con.startup(self.getStartupConf());
        });
        this._attachListeners(con);
        con.once("end", () => {
          const error = this._ending ? new Error("Connection terminated") : new Error("Connection terminated unexpectedly");
          clearTimeout(this.connectionTimeoutHandle);
          this._errorAllQueries(error);
          this._ended = true;
          if (!this._ending) {
            if (this._connecting && !this._connectionError) {
              if (this._connectionCallback) {
                this._connectionCallback(error);
              } else {
                this._handleErrorEvent(error);
              }
            } else if (!this._connectionError) {
              this._handleErrorEvent(error);
            }
          }
          process.nextTick(() => {
            this.emit("end");
          });
        });
      }
      connect(callback) {
        if (callback) {
          this._connect(callback);
          return;
        }
        return new this._Promise((resolve, reject) => {
          this._connect((error) => {
            if (error) {
              reject(error);
            } else {
              resolve(this);
            }
          });
        });
      }
      _attachListeners(con) {
        con.on("authenticationCleartextPassword", this._handleAuthCleartextPassword.bind(this));
        con.on("authenticationMD5Password", this._handleAuthMD5Password.bind(this));
        con.on("authenticationSASL", this._handleAuthSASL.bind(this));
        con.on("authenticationSASLContinue", this._handleAuthSASLContinue.bind(this));
        con.on("authenticationSASLFinal", this._handleAuthSASLFinal.bind(this));
        con.on("backendKeyData", this._handleBackendKeyData.bind(this));
        con.on("error", this._handleErrorEvent.bind(this));
        con.on("errorMessage", this._handleErrorMessage.bind(this));
        con.on("readyForQuery", this._handleReadyForQuery.bind(this));
        con.on("notice", this._handleNotice.bind(this));
        con.on("rowDescription", this._handleRowDescription.bind(this));
        con.on("dataRow", this._handleDataRow.bind(this));
        con.on("portalSuspended", this._handlePortalSuspended.bind(this));
        con.on("emptyQuery", this._handleEmptyQuery.bind(this));
        con.on("commandComplete", this._handleCommandComplete.bind(this));
        con.on("parseComplete", this._handleParseComplete.bind(this));
        con.on("copyInResponse", this._handleCopyInResponse.bind(this));
        con.on("copyData", this._handleCopyData.bind(this));
        con.on("notification", this._handleNotification.bind(this));
      }
      _getPassword(cb) {
        const con = this.connection;
        if (typeof this.password === "function") {
          this._Promise.resolve().then(() => this.password(this.connectionParameters)).then((pass) => {
            if (pass !== void 0) {
              if (typeof pass !== "string") {
                con.emit("error", new TypeError("Password must be a string"));
                return;
              }
              this.connectionParameters.password = this.password = pass;
            } else {
              this.connectionParameters.password = this.password = null;
            }
            cb();
          }).catch((err) => {
            con.emit("error", err);
          });
        } else if (this.password !== null) {
          cb();
        } else {
          try {
            const pgPass = require_lib();
            pgPass(this.connectionParameters, (pass) => {
              if (void 0 !== pass) {
                pgPassDeprecationNotice();
                this.connectionParameters.password = this.password = pass;
              }
              cb();
            });
          } catch (e) {
            this.emit("error", e);
          }
        }
      }
      _handleAuthCleartextPassword(msg) {
        this._getPassword(() => {
          this.connection.password(this.password);
        });
      }
      _handleAuthMD5Password(msg) {
        this._getPassword(async () => {
          try {
            const hashedPassword = await crypto.postgresMd5PasswordHash(this.user, this.password, msg.salt);
            this.connection.password(hashedPassword);
          } catch (e) {
            this.emit("error", e);
          }
        });
      }
      _handleAuthSASL(msg) {
        this._getPassword(() => {
          try {
            this.saslSession = sasl.startSession(
              msg.mechanisms,
              this.enableChannelBinding && this.connection.stream,
              this.scramMaxIterations
            );
            this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession.response);
          } catch (err) {
            this.connection.emit("error", err);
          }
        });
      }
      async _handleAuthSASLContinue(msg) {
        try {
          await sasl.continueSession(
            this.saslSession,
            this.password,
            msg.data,
            this.enableChannelBinding && this.connection.stream
          );
          this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleAuthSASLFinal(msg) {
        try {
          sasl.finalizeSession(this.saslSession, msg.data);
          this.saslSession = null;
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleBackendKeyData(msg) {
        this.processID = msg.processID;
        this.secretKey = msg.secretKey;
      }
      _handleReadyForQuery(msg) {
        if (this._connecting) {
          this._connecting = false;
          this._connected = true;
          clearTimeout(this.connectionTimeoutHandle);
          if (this._connectionCallback) {
            this._connectionCallback(null, this);
            this._connectionCallback = null;
          }
          this.emit("connect");
        }
        const activeQuery = this._getActiveQuery();
        this._activeQuery = null;
        this._txStatus = msg?.status ?? null;
        this.readyForQuery = true;
        if (activeQuery) {
          activeQuery.handleReadyForQuery(this.connection);
        }
        this._pulseQueryQueue();
      }
      // if we receive an error event or error message
      // during the connection process we handle it here
      _handleErrorWhileConnecting(err) {
        if (this._connectionError) {
          return;
        }
        this._connectionError = true;
        clearTimeout(this.connectionTimeoutHandle);
        if (this._connectionCallback) {
          return this._connectionCallback(err);
        }
        this.emit("error", err);
      }
      // if we're connected and we receive an error event from the connection
      // this means the socket is dead - do a hard abort of all queries and emit
      // the socket error on the client as well
      _handleErrorEvent(err) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(err);
        }
        this._queryable = false;
        this._errorAllQueries(err);
        this.emit("error", err);
      }
      // handle error messages from the postgres backend
      _handleErrorMessage(msg) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(msg);
        }
        const activeQuery = this._getActiveQuery();
        if (!activeQuery) {
          this._handleErrorEvent(msg);
          return;
        }
        this._activeQuery = null;
        activeQuery.handleError(msg, this.connection);
      }
      _handleRowDescription(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected rowDescription message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleRowDescription(msg);
      }
      _handleDataRow(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected dataRow message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleDataRow(msg);
      }
      _handlePortalSuspended(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected portalSuspended message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handlePortalSuspended(this.connection);
      }
      _handleEmptyQuery(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected emptyQuery message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleEmptyQuery(this.connection);
      }
      _handleCommandComplete(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected commandComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCommandComplete(msg, this.connection);
      }
      _handleParseComplete() {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected parseComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        if (activeQuery.name) {
          this.connection.parsedStatements[activeQuery.name] = activeQuery.text;
        }
      }
      _handleCopyInResponse(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyInResponse message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyInResponse(this.connection);
      }
      _handleCopyData(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyData message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyData(msg, this.connection);
      }
      _handleNotification(msg) {
        this.emit("notification", msg);
      }
      _handleNotice(msg) {
        this.emit("notice", msg);
      }
      getStartupConf() {
        const params = this.connectionParameters;
        const data = {
          user: params.user,
          database: params.database
        };
        const appName = params.application_name || params.fallback_application_name;
        if (appName) {
          data.application_name = appName;
        }
        if (params.replication) {
          data.replication = "" + params.replication;
        }
        if (params.statement_timeout) {
          data.statement_timeout = String(parseInt(params.statement_timeout, 10));
        }
        if (params.lock_timeout) {
          data.lock_timeout = String(parseInt(params.lock_timeout, 10));
        }
        if (params.idle_in_transaction_session_timeout) {
          data.idle_in_transaction_session_timeout = String(parseInt(params.idle_in_transaction_session_timeout, 10));
        }
        if (params.options) {
          data.options = params.options;
        }
        return data;
      }
      cancel(client, query) {
        if (client.activeQuery === query) {
          const con = this.connection;
          if (this.host && this.host.indexOf("/") === 0) {
            con.connect(this.host + "/.s.PGSQL." + this.port);
          } else {
            con.connect(this.port, this.host);
          }
          con.on("connect", function() {
            con.cancel(client.processID, client.secretKey);
          });
        } else if (client._queryQueue.indexOf(query) !== -1) {
          client._queryQueue.splice(client._queryQueue.indexOf(query), 1);
        }
      }
      setTypeParser(oid, format, parseFn) {
        return this._types.setTypeParser(oid, format, parseFn);
      }
      getTypeParser(oid, format) {
        return this._types.getTypeParser(oid, format);
      }
      // escapeIdentifier and escapeLiteral moved to utility functions & exported
      // on PG
      // re-exported here for backwards compatibility
      escapeIdentifier(str) {
        return utils.escapeIdentifier(str);
      }
      escapeLiteral(str) {
        return utils.escapeLiteral(str);
      }
      _pulseQueryQueue() {
        if (this.readyForQuery === true) {
          this._activeQuery = this._queryQueue.shift();
          const activeQuery = this._getActiveQuery();
          if (activeQuery) {
            this.readyForQuery = false;
            this.hasExecuted = true;
            const queryError = activeQuery.submit(this.connection);
            if (queryError) {
              process.nextTick(() => {
                activeQuery.handleError(queryError, this.connection);
                this.readyForQuery = true;
                this._pulseQueryQueue();
              });
            }
          } else if (this.hasExecuted) {
            this._activeQuery = null;
            this.emit("drain");
          }
        }
      }
      query(config, values, callback) {
        let query;
        let result;
        if (config == null) {
          throw new TypeError("Client was passed a null or undefined query");
        }
        if (typeof config.submit === "function") {
          result = query = config;
          if (!query.callback) {
            if (typeof values === "function") {
              query.callback = values;
            } else if (callback) {
              query.callback = callback;
            }
          }
        } else {
          query = new Query2(config, values, callback);
          if (!query.callback) {
            result = new this._Promise((resolve, reject) => {
              query.callback = (err, res) => err ? reject(err) : resolve(res);
            }).catch((err) => {
              Error.captureStackTrace(err);
              throw err;
            });
          } else if (typeof query.callback !== "function") {
            throw new TypeError("callback is not a function");
          }
        }
        const readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        if (readTimeout) {
          const queryCallback = query.callback || (() => {
          });
          const readTimeoutTimer = setTimeout(() => {
            const error = new Error("Query read timeout");
            process.nextTick(() => {
              query.handleError(error, this.connection);
            });
            queryCallback(error);
            query.callback = () => {
            };
            const index = this._queryQueue.indexOf(query);
            if (index > -1) {
              this._queryQueue.splice(index, 1);
            }
            this._pulseQueryQueue();
          }, readTimeout);
          query.callback = (err, res) => {
            clearTimeout(readTimeoutTimer);
            queryCallback(err, res);
          };
        }
        if (this.binary && !query.binary) {
          query.binary = true;
        }
        if (query._result && !query._result._types) {
          query._result._types = this._types;
        }
        if (!this._queryable) {
          process.nextTick(() => {
            query.handleError(new Error("Client has encountered a connection error and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._ending) {
          process.nextTick(() => {
            query.handleError(new Error("Client was closed and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._queryQueue.length > 0) {
          queryQueueLengthDeprecationNotice();
        }
        this._queryQueue.push(query);
        this._pulseQueryQueue();
        return result;
      }
      ref() {
        this.connection.ref();
      }
      unref() {
        this.connection.unref();
      }
      getTransactionStatus() {
        return this._txStatus;
      }
      end(cb) {
        this._ending = true;
        if (!this.connection._connecting || this._ended) {
          if (cb) {
            cb();
            return;
          } else {
            return this._Promise.resolve();
          }
        }
        if (this._getActiveQuery() || !this._queryable) {
          this.connection.stream.destroy();
        } else {
          this.connection.end();
        }
        if (cb) {
          this.connection.once("end", cb);
        } else {
          return new this._Promise((resolve) => {
            this.connection.once("end", resolve);
          });
        }
      }
      get queryQueue() {
        queryQueueDeprecationNotice();
        return this._queryQueue;
      }
    };
    Client2.Query = Query2;
    module.exports = Client2;
  }
});

// node_modules/pg-pool/index.js
var require_pg_pool = __commonJS({
  "node_modules/pg-pool/index.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var NOOP = function() {
    };
    var removeWhere = (list, predicate) => {
      const i = list.findIndex(predicate);
      return i === -1 ? void 0 : list.splice(i, 1)[0];
    };
    var IdleItem = class {
      constructor(client, idleListener, timeoutId) {
        this.client = client;
        this.idleListener = idleListener;
        this.timeoutId = timeoutId;
      }
    };
    var PendingItem = class {
      constructor(callback) {
        this.callback = callback;
      }
    };
    function throwOnDoubleRelease() {
      throw new Error("Release called on client which has already been released to the pool.");
    }
    function promisify(Promise2, callback) {
      if (callback) {
        return { callback, result: void 0 };
      }
      let rej;
      let res;
      const cb = function(err, client) {
        err ? rej(err) : res(client);
      };
      const result = new Promise2(function(resolve, reject) {
        res = resolve;
        rej = reject;
      }).catch((err) => {
        Error.captureStackTrace(err);
        throw err;
      });
      return { callback: cb, result };
    }
    function makeIdleListener(pool, client) {
      return function idleListener(err) {
        err.client = client;
        client.removeListener("error", idleListener);
        client.on("error", () => {
          pool.log("additional client error after disconnection due to error", err);
        });
        pool._remove(client);
        pool.emit("error", err, client);
      };
    }
    var Pool2 = class extends EventEmitter {
      constructor(options, Client2) {
        super();
        this.options = Object.assign({}, options);
        if (options != null && "password" in options) {
          Object.defineProperty(this.options, "password", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: options.password
          });
        }
        if (options != null && options.ssl && options.ssl.key) {
          Object.defineProperty(this.options.ssl, "key", {
            enumerable: false
          });
        }
        this.options.max = this.options.max || this.options.poolSize || 10;
        this.options.min = this.options.min || 0;
        this.options.maxUses = this.options.maxUses || Infinity;
        this.options.allowExitOnIdle = this.options.allowExitOnIdle || false;
        this.options.maxLifetimeSeconds = this.options.maxLifetimeSeconds || 0;
        this.log = this.options.log || function() {
        };
        this.Client = this.options.Client || Client2 || require_lib2().Client;
        this.Promise = this.options.Promise || global.Promise;
        if (typeof this.options.idleTimeoutMillis === "undefined") {
          this.options.idleTimeoutMillis = 1e4;
        }
        this._clients = [];
        this._idle = [];
        this._expired = /* @__PURE__ */ new WeakSet();
        this._pendingQueue = [];
        this._endCallback = void 0;
        this.ending = false;
        this.ended = false;
      }
      _promiseTry(f) {
        const Promise2 = this.Promise;
        if (typeof Promise2.try === "function") {
          return Promise2.try(f);
        }
        return new Promise2((resolve) => resolve(f()));
      }
      _isFull() {
        return this._clients.length >= this.options.max;
      }
      _isAboveMin() {
        return this._clients.length > this.options.min;
      }
      _pulseQueue() {
        this.log("pulse queue");
        if (this.ended) {
          this.log("pulse queue ended");
          return;
        }
        if (this.ending) {
          this.log("pulse queue on ending");
          if (this._idle.length) {
            this._idle.slice().map((item) => {
              this._remove(item.client);
            });
          }
          if (!this._clients.length) {
            this.ended = true;
            this._endCallback();
          }
          return;
        }
        if (!this._pendingQueue.length) {
          this.log("no queued requests");
          return;
        }
        if (!this._idle.length && this._isFull()) {
          return;
        }
        const pendingItem = this._pendingQueue.shift();
        if (this._idle.length) {
          const idleItem = this._idle.pop();
          clearTimeout(idleItem.timeoutId);
          const client = idleItem.client;
          client.ref && client.ref();
          const idleListener = idleItem.idleListener;
          return this._acquireClient(client, pendingItem, idleListener, false);
        }
        if (!this._isFull()) {
          return this.newClient(pendingItem);
        }
        throw new Error("unexpected condition");
      }
      _remove(client, callback) {
        const removed = removeWhere(this._idle, (item) => item.client === client);
        if (removed !== void 0) {
          clearTimeout(removed.timeoutId);
        }
        this._clients = this._clients.filter((c) => c !== client);
        const context = this;
        client.end(() => {
          context.emit("remove", client);
          if (typeof callback === "function") {
            callback();
          }
        });
      }
      connect(cb) {
        if (this.ending) {
          const err = new Error("Cannot use a pool after calling end on the pool");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        const response = promisify(this.Promise, cb);
        const result = response.result;
        if (this._isFull() || this._idle.length) {
          if (this._idle.length) {
            process.nextTick(() => this._pulseQueue());
          }
          if (!this.options.connectionTimeoutMillis) {
            this._pendingQueue.push(new PendingItem(response.callback));
            return result;
          }
          const queueCallback = (err, res, done) => {
            clearTimeout(tid);
            response.callback(err, res, done);
          };
          const pendingItem = new PendingItem(queueCallback);
          const tid = setTimeout(() => {
            removeWhere(this._pendingQueue, (i) => i.callback === queueCallback);
            pendingItem.timedOut = true;
            response.callback(new Error("timeout exceeded when trying to connect"));
          }, this.options.connectionTimeoutMillis);
          if (tid.unref) {
            tid.unref();
          }
          this._pendingQueue.push(pendingItem);
          return result;
        }
        this.newClient(new PendingItem(response.callback));
        return result;
      }
      newClient(pendingItem) {
        const client = new this.Client(this.options);
        this._clients.push(client);
        const idleListener = makeIdleListener(this, client);
        this.log("checking client timeout");
        let tid;
        let timeoutHit = false;
        if (this.options.connectionTimeoutMillis) {
          tid = setTimeout(() => {
            if (client.connection) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.connection.stream.destroy();
            } else if (!client.isConnected()) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.end();
            }
          }, this.options.connectionTimeoutMillis);
        }
        this.log("connecting new client");
        client.connect((err) => {
          if (tid) {
            clearTimeout(tid);
          }
          client.on("error", idleListener);
          if (err) {
            this.log("client failed to connect", err);
            this._clients = this._clients.filter((c) => c !== client);
            if (timeoutHit) {
              err = new Error("Connection terminated due to connection timeout", { cause: err });
            }
            this._pulseQueue();
            if (!pendingItem.timedOut) {
              pendingItem.callback(err, void 0, NOOP);
            }
          } else {
            this.log("new client connected");
            if (this.options.onConnect) {
              this._promiseTry(() => this.options.onConnect(client)).then(
                () => {
                  this._afterConnect(client, pendingItem, idleListener);
                },
                (hookErr) => {
                  this._clients = this._clients.filter((c) => c !== client);
                  client.end(() => {
                    this._pulseQueue();
                    if (!pendingItem.timedOut) {
                      pendingItem.callback(hookErr, void 0, NOOP);
                    }
                  });
                }
              );
              return;
            }
            return this._afterConnect(client, pendingItem, idleListener);
          }
        });
      }
      _afterConnect(client, pendingItem, idleListener) {
        if (this.options.maxLifetimeSeconds !== 0) {
          const maxLifetimeTimeout = setTimeout(() => {
            this.log("ending client due to expired lifetime");
            this._expired.add(client);
            const idleIndex = this._idle.findIndex((idleItem) => idleItem.client === client);
            if (idleIndex !== -1) {
              this._acquireClient(
                client,
                new PendingItem((err, client2, clientRelease) => clientRelease()),
                idleListener,
                false
              );
            }
          }, this.options.maxLifetimeSeconds * 1e3);
          maxLifetimeTimeout.unref();
          client.once("end", () => clearTimeout(maxLifetimeTimeout));
        }
        return this._acquireClient(client, pendingItem, idleListener, true);
      }
      // acquire a client for a pending work item
      _acquireClient(client, pendingItem, idleListener, isNew) {
        if (isNew) {
          this.emit("connect", client);
        }
        this.emit("acquire", client);
        client.release = this._releaseOnce(client, idleListener);
        client.removeListener("error", idleListener);
        if (!pendingItem.timedOut) {
          if (isNew && this.options.verify) {
            this.options.verify(client, (err) => {
              if (err) {
                client.release(err);
                return pendingItem.callback(err, void 0, NOOP);
              }
              pendingItem.callback(void 0, client, client.release);
            });
          } else {
            pendingItem.callback(void 0, client, client.release);
          }
        } else {
          if (isNew && this.options.verify) {
            this.options.verify(client, client.release);
          } else {
            client.release();
          }
        }
      }
      // returns a function that wraps _release and throws if called more than once
      _releaseOnce(client, idleListener) {
        let released = false;
        return (err) => {
          if (released) {
            throwOnDoubleRelease();
          }
          released = true;
          this._release(client, idleListener, err);
        };
      }
      // release a client back to the poll, include an error
      // to remove it from the pool
      _release(client, idleListener, err) {
        client.on("error", idleListener);
        client._poolUseCount = (client._poolUseCount || 0) + 1;
        this.emit("release", err, client);
        if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= this.options.maxUses) {
          if (client._poolUseCount >= this.options.maxUses) {
            this.log("remove expended client");
          }
          return this._remove(client, this._pulseQueue.bind(this));
        }
        const isExpired = this._expired.has(client);
        if (isExpired) {
          this.log("remove expired client");
          this._expired.delete(client);
          return this._remove(client, this._pulseQueue.bind(this));
        }
        let tid;
        if (this.options.idleTimeoutMillis && this._isAboveMin()) {
          tid = setTimeout(() => {
            if (this._isAboveMin()) {
              this.log("remove idle client");
              this._remove(client, this._pulseQueue.bind(this));
            }
          }, this.options.idleTimeoutMillis);
          if (this.options.allowExitOnIdle) {
            tid.unref();
          }
        }
        if (this.options.allowExitOnIdle) {
          client.unref();
        }
        this._idle.push(new IdleItem(client, idleListener, tid));
        this._pulseQueue();
      }
      query(text, values, cb) {
        if (typeof text === "function") {
          const response2 = promisify(this.Promise, text);
          setImmediate(function() {
            return response2.callback(new Error("Passing a function as the first parameter to pool.query is not supported"));
          });
          return response2.result;
        }
        if (typeof values === "function") {
          cb = values;
          values = void 0;
        }
        const response = promisify(this.Promise, cb);
        cb = response.callback;
        this.connect((err, client) => {
          if (err) {
            return cb(err);
          }
          let clientReleased = false;
          const onError = (err2) => {
            if (clientReleased) {
              return;
            }
            clientReleased = true;
            client.release(err2);
            cb(err2);
          };
          client.once("error", onError);
          this.log("dispatching query");
          try {
            client.query(text, values, (err2, res) => {
              this.log("query dispatched");
              client.removeListener("error", onError);
              if (clientReleased) {
                return;
              }
              clientReleased = true;
              client.release(err2);
              if (err2) {
                return cb(err2);
              }
              return cb(void 0, res);
            });
          } catch (err2) {
            client.release(err2);
            return cb(err2);
          }
        });
        return response.result;
      }
      end(cb) {
        this.log("ending");
        if (this.ending) {
          const err = new Error("Called end on pool more than once");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        this.ending = true;
        const promised = promisify(this.Promise, cb);
        this._endCallback = promised.callback;
        this._pulseQueue();
        return promised.result;
      }
      get waitingCount() {
        return this._pendingQueue.length;
      }
      get idleCount() {
        return this._idle.length;
      }
      get expiredCount() {
        return this._clients.reduce((acc, client) => acc + (this._expired.has(client) ? 1 : 0), 0);
      }
      get totalCount() {
        return this._clients.length;
      }
    };
    module.exports = Pool2;
  }
});

// node_modules/pg/lib/native/query.js
var require_query2 = __commonJS({
  "node_modules/pg/lib/native/query.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var utils = require_utils();
    var NativeQuery = module.exports = function(config, values, callback) {
      EventEmitter.call(this);
      config = utils.normalizeQueryConfig(config, values, callback);
      this.text = config.text;
      this.values = config.values;
      this.name = config.name;
      this.queryMode = config.queryMode;
      this.callback = config.callback;
      this.state = "new";
      this._arrayMode = config.rowMode === "array";
      this._emitRowEvents = false;
      this.on(
        "newListener",
        function(event) {
          if (event === "row") this._emitRowEvents = true;
        }.bind(this)
      );
    };
    util.inherits(NativeQuery, EventEmitter);
    var errorFieldMap = {
      sqlState: "code",
      statementPosition: "position",
      messagePrimary: "message",
      context: "where",
      schemaName: "schema",
      tableName: "table",
      columnName: "column",
      dataTypeName: "dataType",
      constraintName: "constraint",
      sourceFile: "file",
      sourceLine: "line",
      sourceFunction: "routine"
    };
    NativeQuery.prototype.handleError = function(err) {
      const fields = this.native.pq.resultErrorFields();
      if (fields) {
        for (const key in fields) {
          const normalizedFieldName = errorFieldMap[key] || key;
          err[normalizedFieldName] = fields[key];
        }
      }
      if (this.callback) {
        this.callback(err);
      } else {
        this.emit("error", err);
      }
      this.state = "error";
    };
    NativeQuery.prototype.then = function(onSuccess, onFailure) {
      return this._getPromise().then(onSuccess, onFailure);
    };
    NativeQuery.prototype.catch = function(callback) {
      return this._getPromise().catch(callback);
    };
    NativeQuery.prototype._getPromise = function() {
      if (this._promise) return this._promise;
      this._promise = new Promise(
        function(resolve, reject) {
          this._once("end", resolve);
          this._once("error", reject);
        }.bind(this)
      );
      return this._promise;
    };
    NativeQuery.prototype.submit = function(client) {
      this.state = "running";
      const self = this;
      this.native = client.native;
      client.native.arrayMode = this._arrayMode;
      let after = function(err, rows, results) {
        client.native.arrayMode = false;
        setImmediate(function() {
          self.emit("_done");
        });
        if (err) {
          return self.handleError(err);
        }
        if (self._emitRowEvents) {
          if (results.length > 1) {
            rows.forEach((rowOfRows, i) => {
              rowOfRows.forEach((row) => {
                self.emit("row", row, results[i]);
              });
            });
          } else {
            rows.forEach(function(row) {
              self.emit("row", row, results);
            });
          }
        }
        self.state = "end";
        self.emit("end", results);
        if (self.callback) {
          self.callback(null, results);
        }
      };
      if (process.domain) {
        after = process.domain.bind(after);
      }
      if (this.name) {
        if (this.name.length > 63) {
          console.error("Warning! Postgres only supports 63 characters for query names.");
          console.error("You supplied %s (%s)", this.name, this.name.length);
          console.error("This can cause conflicts and silent errors executing queries");
        }
        const values = (this.values || []).map(utils.prepareValue);
        if (client.namedQueries[this.name]) {
          if (this.text && client.namedQueries[this.name] !== this.text) {
            const err = new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
            return after(err);
          }
          return client.native.execute(this.name, values, after);
        }
        return client.native.prepare(this.name, this.text, values.length, function(err) {
          if (err) return after(err);
          client.namedQueries[self.name] = self.text;
          return self.native.execute(self.name, values, after);
        });
      } else if (this.values) {
        if (!Array.isArray(this.values)) {
          const err = new Error("Query values must be an array");
          return after(err);
        }
        const vals = this.values.map(utils.prepareValue);
        client.native.query(this.text, vals, after);
      } else if (this.queryMode === "extended") {
        client.native.query(this.text, [], after);
      } else {
        client.native.query(this.text, after);
      }
    };
  }
});

// node_modules/pg/lib/native/client.js
var require_client2 = __commonJS({
  "node_modules/pg/lib/native/client.js"(exports, module) {
    var nodeUtils = __require("util");
    var Native;
    try {
      Native = __require("pg-native");
    } catch (e) {
      throw e;
    }
    var TypeOverrides2 = require_type_overrides();
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var ConnectionParameters = require_connection_parameters();
    var NativeQuery = require_query2();
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    var Client2 = module.exports = function(config) {
      EventEmitter.call(this);
      config = config || {};
      this._Promise = config.Promise || global.Promise;
      this._types = new TypeOverrides2(config.types);
      this.native = new Native({
        types: this._types
      });
      this._queryQueue = [];
      this._ending = false;
      this._connecting = false;
      this._connected = false;
      this._queryable = true;
      const cp = this.connectionParameters = new ConnectionParameters(config);
      if (config.nativeConnectionString) cp.nativeConnectionString = config.nativeConnectionString;
      this.user = cp.user;
      Object.defineProperty(this, "password", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: cp.password
      });
      this.database = cp.database;
      this.host = cp.host;
      this.port = cp.port;
      this.namedQueries = {};
    };
    Client2.Query = NativeQuery;
    util.inherits(Client2, EventEmitter);
    Client2.prototype._errorAllQueries = function(err) {
      const enqueueError = (query) => {
        process.nextTick(() => {
          query.native = this.native;
          query.handleError(err);
        });
      };
      if (this._hasActiveQuery()) {
        enqueueError(this._activeQuery);
        this._activeQuery = null;
      }
      this._queryQueue.forEach(enqueueError);
      this._queryQueue.length = 0;
    };
    Client2.prototype._connect = function(cb) {
      const self = this;
      if (this._connecting) {
        process.nextTick(() => cb(new Error("Client has already been connected. You cannot reuse a client.")));
        return;
      }
      this._connecting = true;
      this.connectionParameters.getLibpqConnectionString(function(err, conString) {
        if (self.connectionParameters.nativeConnectionString) conString = self.connectionParameters.nativeConnectionString;
        if (err) return cb(err);
        self.native.connect(conString, function(err2) {
          if (err2) {
            self.native.end();
            return cb(err2);
          }
          self._connected = true;
          self.native.on("error", function(err3) {
            self._queryable = false;
            self._errorAllQueries(err3);
            self.emit("error", err3);
          });
          self.native.on("notification", function(msg) {
            self.emit("notification", {
              channel: msg.relname,
              payload: msg.extra
            });
          });
          self.emit("connect");
          self._pulseQueryQueue(true);
          cb(null, this);
        });
      });
    };
    Client2.prototype.connect = function(callback) {
      if (callback) {
        this._connect(callback);
        return;
      }
      return new this._Promise((resolve, reject) => {
        this._connect((error) => {
          if (error) {
            reject(error);
          } else {
            resolve(this);
          }
        });
      });
    };
    Client2.prototype.query = function(config, values, callback) {
      let query;
      let result;
      let readTimeout;
      let readTimeoutTimer;
      let queryCallback;
      if (config === null || config === void 0) {
        throw new TypeError("Client was passed a null or undefined query");
      } else if (typeof config.submit === "function") {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        result = query = config;
        if (typeof values === "function") {
          config.callback = values;
        }
      } else {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        query = new NativeQuery(config, values, callback);
        if (!query.callback) {
          let resolveOut, rejectOut;
          result = new this._Promise((resolve, reject) => {
            resolveOut = resolve;
            rejectOut = reject;
          }).catch((err) => {
            Error.captureStackTrace(err);
            throw err;
          });
          query.callback = (err, res) => err ? rejectOut(err) : resolveOut(res);
        }
      }
      if (readTimeout) {
        queryCallback = query.callback || (() => {
        });
        readTimeoutTimer = setTimeout(() => {
          const error = new Error("Query read timeout");
          process.nextTick(() => {
            query.handleError(error, this.connection);
          });
          queryCallback(error);
          query.callback = () => {
          };
          const index = this._queryQueue.indexOf(query);
          if (index > -1) {
            this._queryQueue.splice(index, 1);
          }
          this._pulseQueryQueue();
        }, readTimeout);
        query.callback = (err, res) => {
          clearTimeout(readTimeoutTimer);
          queryCallback(err, res);
        };
      }
      if (!this._queryable) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client has encountered a connection error and is not queryable"));
        });
        return result;
      }
      if (this._ending) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client was closed and is not queryable"));
        });
        return result;
      }
      if (this._queryQueue.length > 0) {
        queryQueueLengthDeprecationNotice();
      }
      this._queryQueue.push(query);
      this._pulseQueryQueue();
      return result;
    };
    Client2.prototype.end = function(cb) {
      const self = this;
      this._ending = true;
      if (this._connecting && !this._connected) {
        this.once("connect", () => {
          this.end(() => {
          });
        });
      }
      let result;
      if (!cb) {
        result = new this._Promise(function(resolve, reject) {
          cb = (err) => err ? reject(err) : resolve();
        });
      }
      this.native.end(function() {
        self._connected = false;
        self._errorAllQueries(new Error("Connection terminated"));
        process.nextTick(() => {
          self.emit("end");
          if (cb) cb();
        });
      });
      return result;
    };
    Client2.prototype._hasActiveQuery = function() {
      return this._activeQuery && this._activeQuery.state !== "error" && this._activeQuery.state !== "end";
    };
    Client2.prototype._pulseQueryQueue = function(initialConnection) {
      if (!this._connected) {
        return;
      }
      if (this._hasActiveQuery()) {
        return;
      }
      const query = this._queryQueue.shift();
      if (!query) {
        if (!initialConnection) {
          this.emit("drain");
        }
        return;
      }
      this._activeQuery = query;
      query.submit(this);
      const self = this;
      query.once("_done", function() {
        self._pulseQueryQueue();
      });
    };
    Client2.prototype.cancel = function(query) {
      if (this._activeQuery === query) {
        this.native.cancel(function() {
        });
      } else if (this._queryQueue.indexOf(query) !== -1) {
        this._queryQueue.splice(this._queryQueue.indexOf(query), 1);
      }
    };
    Client2.prototype.ref = function() {
    };
    Client2.prototype.unref = function() {
    };
    Client2.prototype.setTypeParser = function(oid, format, parseFn) {
      return this._types.setTypeParser(oid, format, parseFn);
    };
    Client2.prototype.getTypeParser = function(oid, format) {
      return this._types.getTypeParser(oid, format);
    };
    Client2.prototype.isConnected = function() {
      return this._connected;
    };
    Client2.prototype.getTransactionStatus = function() {
      return this.native.getTransactionStatus();
    };
  }
});

// node_modules/pg/lib/native/index.js
var require_native = __commonJS({
  "node_modules/pg/lib/native/index.js"(exports, module) {
    "use strict";
    module.exports = require_client2();
  }
});

// node_modules/pg/lib/index.js
var require_lib2 = __commonJS({
  "node_modules/pg/lib/index.js"(exports, module) {
    "use strict";
    var Client2 = require_client();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var Result2 = require_result();
    var utils = require_utils();
    var Pool2 = require_pg_pool();
    var TypeOverrides2 = require_type_overrides();
    var { DatabaseError: DatabaseError2 } = require_dist();
    var { escapeIdentifier: escapeIdentifier2, escapeLiteral: escapeLiteral2 } = require_utils();
    var poolFactory = (Client3) => {
      return class BoundPool extends Pool2 {
        constructor(options) {
          super(options, Client3);
        }
      };
    };
    var PG = function(clientConstructor2) {
      this.defaults = defaults2;
      this.Client = clientConstructor2;
      this.Query = this.Client.Query;
      this.Pool = poolFactory(this.Client);
      this._pools = [];
      this.Connection = Connection2;
      this.types = require_pg_types();
      this.DatabaseError = DatabaseError2;
      this.TypeOverrides = TypeOverrides2;
      this.escapeIdentifier = escapeIdentifier2;
      this.escapeLiteral = escapeLiteral2;
      this.Result = Result2;
      this.utils = utils;
    };
    var clientConstructor = Client2;
    var forceNative = false;
    try {
      forceNative = !!process.env.NODE_PG_FORCE_NATIVE;
    } catch {
    }
    if (forceNative) {
      clientConstructor = require_native();
    }
    module.exports = new PG(clientConstructor);
    Object.defineProperty(module.exports, "native", {
      configurable: true,
      enumerable: false,
      get() {
        let native = null;
        try {
          native = new PG(require_native());
        } catch (err) {
          if (err.code !== "MODULE_NOT_FOUND") {
            throw err;
          }
        }
        Object.defineProperty(module.exports, "native", {
          value: native
        });
        return native;
      }
    });
  }
});

// scripts/start-production-load-test-control-service.ts
import path8 from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/performance/load-report.ts
var PRODUCTION_LOAD_THRESHOLDS = Object.freeze({
  normalHttpFailureRateMax: 5e-3,
  acknowledgedMutationFailuresMax: 0,
  nonRunnerP95Ms: 2e3,
  nonRunnerP99Ms: 5e3,
  runnerAdmissionP95Ms: 2e3,
  runnerQueueWaitP95Ms: 6e4,
  runnerQueueWaitMaxMs: 12e4,
  componentRecoveryMaxMs: 3e5,
  queueDrainMaxMs: 6e5,
  alertVisibilityMaxMs: 6e4,
  postgresConnectionsFractionMax: 0.8,
  postgresLockWaitP95Ms: 1e3,
  deadlocksMax: 0,
  oomKillsMax: 0,
  thermalThrottleIncrementsMax: 0,
  minAvailableMemoryBytes: 8589934592,
  minRootFreeFraction: 0.15,
  maxTemperatureCelsius: 90,
  maxConcurrentRunnerJobs: 2
});
var productionFaultIds = [
  "runner_service_restart",
  "app_container_restart",
  "email_worker_restart",
  "assessment_regrade_worker_restart",
  "project_review_correction_worker_restart",
  "exam_finalization_worker_restart",
  "practice_recovery_worker_restart",
  "rewards_worker_restart",
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert"
];
var PRODUCTION_LOAD_FAULT_MATRIX = Object.freeze(
  productionFaultIds.map((id) => Object.freeze({
    id,
    healthyBaselineMs: 12e4,
    faultMaxMs: 6e4,
    recoveryMaxMs: 3e5,
    invariantCheckMs: 12e4
  }))
);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertExactFields(value, expected, label) {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((field) => !expected.includes(field))) {
    throw new Error(`Production load decision ${label} contains unexpected or missing fields.`);
  }
}
var productionCandidateFields = [
  "gitSha",
  "gitTree",
  "releaseManifestSha256",
  "applicationImageRecordSha256",
  "composeProject",
  "composeWorkdir",
  "publicOrigin",
  "managedInventorySha256",
  "firewallPolicySha256",
  "runnerGuestReleaseSha256",
  "runnerImageRecordSha256",
  "nucHostId",
  "runnerVmId",
  "datasetId"
];
var productionDecisionFields = [
  "schemaVersion",
  "scope",
  "status",
  "approvedAt",
  "approvedBy",
  "approvalReason",
  "candidate",
  "thresholds"
];
function assertProductionCandidateIdentities(candidate) {
  const gitObject = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const sha256 = /^sha256:[0-9a-f]{64}$/;
  const boundedIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
  if (!gitObject.test(candidate.gitSha)) {
    throw new Error("Production load candidate gitSha identity is invalid.");
  }
  if (!gitObject.test(candidate.gitTree)) {
    throw new Error("Production load candidate gitTree identity is invalid.");
  }
  const digestIdentities = [
    candidate.releaseManifestSha256,
    candidate.applicationImageRecordSha256,
    candidate.managedInventorySha256,
    candidate.firewallPolicySha256,
    candidate.runnerGuestReleaseSha256,
    candidate.runnerImageRecordSha256
  ];
  if (digestIdentities.some((identity) => !sha256.test(identity))) {
    throw new Error("Production load candidate release identity is invalid.");
  }
  if (candidate.composeProject !== "learncoding" || candidate.composeWorkdir !== "/opt/learncoding") {
    throw new Error("Production load candidate Compose identity is invalid.");
  }
  if (!/^https:\/\/(?![0-9]{1,3}(?:\.[0-9]{1,3}){3}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    candidate.publicOrigin
  )) {
    throw new Error("Production load candidate public origin is invalid.");
  }
  let publicOrigin;
  try {
    publicOrigin = new URL(candidate.publicOrigin);
  } catch {
    throw new Error("Production load candidate public origin is invalid.");
  }
  if (publicOrigin.protocol !== "https:" || publicOrigin.origin !== candidate.publicOrigin || publicOrigin.username || publicOrigin.password) {
    throw new Error("Production load candidate public origin is invalid.");
  }
  if (!boundedIdentifier.test(candidate.nucHostId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate.runnerVmId)) {
    throw new Error("Production load candidate host or VM identity is invalid.");
  }
  if (candidate.datasetId !== "seed-20260715") {
    throw new Error("Production load candidate dataset identity is invalid.");
  }
}
var productionActiveReleaseFields = [
  "SCHEMA_VERSION",
  "GIT_COMMIT",
  "GIT_TREE",
  "RELEASE_MANIFEST_SHA256",
  "APPLICATION_IMAGE_RECORD_SHA256",
  "COMPOSE_PROJECT",
  "COMPOSE_WORKDIR",
  "PUBLIC_ORIGIN",
  "MANAGED_INVENTORY_SHA256",
  "FIREWALL_POLICY_SHA256",
  "RUNNER_GUEST_RELEASE_SHA256",
  "RUNNER_RUNTIME_IMAGES_SHA256"
];
function buildProductionLoadCandidateFromActiveRelease(activeReleaseText, nucHostId, runnerVmId) {
  if (!activeReleaseText.endsWith("\n") || activeReleaseText.includes("\r") || activeReleaseText.includes("\0")) {
    throw new Error("Production active-release state must be canonical LF text.");
  }
  const lines = activeReleaseText.slice(0, -1).split("\n");
  if (lines.length !== productionActiveReleaseFields.length) {
    throw new Error("Production active-release state contains unexpected or missing fields.");
  }
  const fields = /* @__PURE__ */ new Map();
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    const value = separator > 0 ? line.slice(separator + 1) : "";
    if (key !== productionActiveReleaseFields[index] || !value || /\s/.test(value) || fields.has(key)) {
      throw new Error("Production active-release state is not canonical.");
    }
    fields.set(key, value);
  }
  if (fields.get("SCHEMA_VERSION") !== "1") {
    throw new Error("Production active-release state schema is unsupported.");
  }
  const provenanceHashFields = [
    "RELEASE_MANIFEST_SHA256",
    "APPLICATION_IMAGE_RECORD_SHA256",
    "MANAGED_INVENTORY_SHA256",
    "FIREWALL_POLICY_SHA256",
    "RUNNER_GUEST_RELEASE_SHA256",
    "RUNNER_RUNTIME_IMAGES_SHA256"
  ];
  if (provenanceHashFields.some((field) => !/^[0-9a-f]{64}$/.test(fields.get(field)))) {
    throw new Error("Production active-release provenance SHA256 identity is invalid.");
  }
  const candidate = {
    gitSha: fields.get("GIT_COMMIT"),
    gitTree: fields.get("GIT_TREE"),
    releaseManifestSha256: `sha256:${fields.get("RELEASE_MANIFEST_SHA256")}`,
    applicationImageRecordSha256: `sha256:${fields.get("APPLICATION_IMAGE_RECORD_SHA256")}`,
    composeProject: fields.get("COMPOSE_PROJECT"),
    composeWorkdir: fields.get("COMPOSE_WORKDIR"),
    publicOrigin: fields.get("PUBLIC_ORIGIN"),
    managedInventorySha256: `sha256:${fields.get("MANAGED_INVENTORY_SHA256")}`,
    firewallPolicySha256: `sha256:${fields.get("FIREWALL_POLICY_SHA256")}`,
    runnerGuestReleaseSha256: `sha256:${fields.get("RUNNER_GUEST_RELEASE_SHA256")}`,
    runnerImageRecordSha256: `sha256:${fields.get("RUNNER_RUNTIME_IMAGES_SHA256")}`,
    nucHostId,
    runnerVmId,
    datasetId: "seed-20260715"
  };
  assertProductionCandidateIdentities(candidate);
  return candidate;
}
function validateProductionLoadDecision(value, expectedCandidate) {
  if (!isRecord(value)) throw new Error("Production load decision must be an object.");
  assertProductionCandidateIdentities(expectedCandidate);
  assertExactFields(value, productionDecisionFields, "artifact");
  if (value.schemaVersion !== 1 || value.scope !== "codestead-project-only" || value.status !== "approved") {
    throw new Error("Production load decision is not an approved schema-version-1 project decision.");
  }
  if (typeof value.approvedAt !== "string" || typeof value.approvedBy !== "string" || !value.approvedBy.trim() || typeof value.approvalReason !== "string" || !value.approvalReason.trim()) {
    throw new Error("Production load decision requires approval time, owner, and reason.");
  }
  const approvedAt = new Date(value.approvedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.approvedAt) || !Number.isFinite(approvedAt.getTime()) || approvedAt.toISOString() !== value.approvedAt) {
    throw new Error("Production load decision approval timestamp must be canonical UTC.");
  }
  if (!isRecord(value.candidate)) {
    throw new Error("Production load decision candidate is missing.");
  }
  assertExactFields(value.candidate, productionCandidateFields, "candidate fields");
  for (const field of productionCandidateFields) {
    if (value.candidate[field] !== expectedCandidate[field]) {
      throw new Error(`Production load decision candidate mismatch: ${field}.`);
    }
  }
  if (!isRecord(value.thresholds)) {
    throw new Error("Production load decision thresholds are missing.");
  }
  assertExactFields(value.thresholds, Object.keys(PRODUCTION_LOAD_THRESHOLDS), "threshold fields");
  for (const [name, expected] of Object.entries(PRODUCTION_LOAD_THRESHOLDS)) {
    if (value.thresholds[name] !== expected) {
      throw new Error(`Production load decision threshold mismatch: ${name}.`);
    }
  }
  return value;
}
function assertLoadTarget(value, allowRemote = false) {
  const target = new URL(value);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Load target must use HTTP or HTTPS.");
  }
  const loopback = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!allowRemote && !loopback.has(target.hostname)) {
    throw new Error("Remote load targets require explicit LOAD_ALLOW_REMOTE=1 authorization.");
  }
  if (target.username || target.password) {
    throw new Error("Do not place credentials in the load-test URL.");
  }
  target.pathname = target.pathname.replace(/\/$/, "");
  target.search = "";
  target.hash = "";
  return target;
}
var permittedSensitiveEvidenceFields = /* @__PURE__ */ new Set(["secretleakfindings"]);
var sensitiveEvidenceFieldFragments = [
  "password",
  "passwd",
  "token",
  "email",
  "cookie",
  "authorization",
  "credential",
  "apikey",
  "privatekey",
  "clientsecret",
  "sharedsecret",
  "sessionid",
  "sessiontoken",
  "databaseurl",
  "dburl",
  "connectionstring",
  "totp",
  "recoverycode",
  "backupidentity",
  "backupkey"
];
var sensitiveEvidenceValue = /authorization\s*:\s*bearer\s+|(?:^|\s)bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:^|\s)nvapi-[A-Za-z0-9_-]+|(?:^|\s)(?:sk-|21st_sk_)[A-Za-z0-9_-]{8,}|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|otpauth:\/\/|totp(?:\s+seed)?\s*[:=]|recovery\s*code\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
function assertProductionLoadEvidenceSafe(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  const visit = (node) => {
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new Error("Load evidence contains a non-finite number.");
      return;
    }
    if (typeof node === "string") {
      if (sensitiveEvidenceValue.test(node)) {
        throw new Error("Load evidence contains a secret-bearing value.");
      }
      return;
    }
    if (typeof node !== "object") {
      throw new Error("Load evidence contains a non-JSON value.");
    }
    if (seen.has(node)) throw new Error("Load evidence contains a cyclic value.");
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Load evidence contains a non-plain object.");
    }
    for (const [key, entry] of Object.entries(node)) {
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if (!permittedSensitiveEvidenceFields.has(normalizedKey) && sensitiveEvidenceFieldFragments.some((fragment) => normalizedKey.includes(fragment))) {
        throw new Error("Load evidence contains a secret-bearing field.");
      }
      visit(entry);
    }
  };
  visit(value);
  return value;
}

// scripts/lib/production-load-active-release.ts
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder as TextDecoder2 } from "node:util";
var PRODUCTION_LOAD_ACTIVE_RELEASE_PATH = "/etc/learncoding/active-release.env";
var maximumActiveReleaseBytes = 64 * 1024;
function fail(code) {
  throw new Error(`Production load active release failed: ${code}`);
}
function sameSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function readProductionLoadActiveRelease(options = {}) {
  const activeReleasePath = path.resolve(
    options.activeReleasePath ?? PRODUCTION_LOAD_ACTIVE_RELEASE_PATH
  );
  if (!path.isAbsolute(activeReleasePath) || activeReleasePath === path.parse(activeReleasePath).root) {
    fail("invalid_path");
  }
  if (process.platform !== "win32") {
    let parent;
    try {
      parent = await realpath(path.dirname(activeReleasePath));
    } catch {
      fail("unsafe_file");
    }
    if (parent !== path.dirname(activeReleasePath)) fail("unsafe_file");
  }
  let metadata;
  try {
    metadata = await lstat(activeReleasePath);
  } catch {
    fail("unsafe_file");
  }
  const requiredMode = options.requiredMode === void 0 ? process.platform === "win32" ? null : 420 : options.requiredMode;
  const requiredOwnerUid = options.requiredOwnerUid === void 0 && process.platform !== "win32" ? 0 : options.requiredOwnerUid;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || requiredMode !== null && (metadata.mode & 511) !== requiredMode || requiredOwnerUid !== void 0 && metadata.uid !== requiredOwnerUid || metadata.size <= 0 || metadata.size > maximumActiveReleaseBytes) {
    fail("unsafe_file");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0;
  let bytes;
  try {
    const handle = await open(activeReleasePath, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!sameSnapshot(metadata, before)) fail("file_changed");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameSnapshot(before, after) || bytes.byteLength !== after.size) {
        fail("file_changed");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Production load active release failed:")) {
      throw error;
    }
    fail("unsafe_file");
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > maximumActiveReleaseBytes || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) {
    fail("invalid_bytes");
  }
  let text;
  try {
    text = new TextDecoder2("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_bytes");
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    fail("invalid_bytes");
  }
  return {
    path: activeReleasePath,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text
  };
}
async function assertProductionLoadActiveReleaseUnchanged(artifact, options = {}) {
  const current = await readProductionLoadActiveRelease(options);
  if (current.path !== artifact.path || current.byteLength !== artifact.byteLength || current.sha256 !== artifact.sha256) {
    fail("active_release_changed");
  }
}

// scripts/lib/production-load-config.ts
import path2 from "node:path";
function fail2(code) {
  throw new Error(`Production load configuration failed: ${code}`);
}
function exact(environment, name, expected) {
  const value = environment[name];
  if (value !== expected) fail2(`invalid_${name.toLowerCase()}`);
  return value;
}
function absolutePath(environment, name) {
  const value = environment[name]?.trim();
  if (!value || !path2.isAbsolute(value)) fail2(`invalid_${name.toLowerCase()}`);
  const resolved = path2.resolve(value);
  if (resolved === path2.parse(resolved).root) fail2(`unsafe_${name.toLowerCase()}`);
  return resolved;
}
function productionTarget(environment) {
  const raw = environment.LOAD_BASE_URL?.trim();
  if (!raw) fail2("missing_load_base_url");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail2("invalid_load_base_url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail2("ambiguous_load_base_url");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    fail2("load_base_url_must_be_origin");
  }
  let target;
  try {
    target = assertLoadTarget(parsed.href, true);
  } catch {
    fail2("unsafe_load_base_url");
  }
  const loopback = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (target.protocol !== "https:" && !loopback.has(target.hostname)) {
    fail2("remote_load_target_requires_https");
  }
  target.pathname = "/";
  return target;
}
function resolveProductionLoadConfig(environment, repositoryRoot) {
  exact(environment, "LOAD_MODE", "production");
  exact(environment, "LOAD_ALLOW_REMOTE", "1");
  exact(environment, "LOAD_SCOPE", "codestead-project-only");
  exact(environment, "LOAD_PROJECT", "learncoding");
  exact(environment, "LOAD_DISPOSABLE_FAULTS_CONFIRMED", "1");
  if (environment.LOAD_COOKIE?.trim()) fail2("load_cookie_forbidden");
  const evidenceRoot = absolutePath(environment, "LOAD_EVIDENCE_ROOT");
  const reportPath = path2.join(evidenceRoot, "load-gate-report.json");
  if (environment.LOAD_REPORT_PATH !== void 0 && path2.resolve(environment.LOAD_REPORT_PATH) !== reportPath) {
    fail2("load_report_path_must_match_evidence_root");
  }
  const nucHostId = environment.LOAD_NUC_HOST_ID?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(nucHostId)) {
    fail2("invalid_load_nuc_host_id");
  }
  const runnerVmId = environment.LOAD_RUNNER_VM_ID?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runnerVmId)) {
    fail2("invalid_load_runner_vm_id");
  }
  return {
    mode: "production",
    allowRemote: true,
    baseUrl: productionTarget(environment),
    scope: "codestead-project-only",
    project: "learncoding",
    disposableFaultsConfirmed: true,
    datasetId: "seed-20260715",
    repositoryRoot: path2.resolve(repositoryRoot),
    evidenceRoot,
    activeReleasePath: absolutePath(environment, "LOAD_ACTIVE_RELEASE_PATH"),
    controlSocket: absolutePath(environment, "LOAD_CONTROL_SOCKET"),
    reportPath,
    nucHostId,
    runnerVmId
  };
}

// scripts/lib/production-load-evidence.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { link, lstat as lstat2, open as open2, realpath as realpath2, unlink } from "node:fs/promises";
import path3 from "node:path";
import { TextDecoder as TextDecoder3 } from "node:util";
var maximumDecisionBytes = 64 * 1024;
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameSnapshot2(left, right) {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function readApprovedProductionLoadDecision(options) {
  const evidenceRoot = path3.resolve(options.evidenceRoot);
  if (process.platform !== "win32" && await realpath2(evidenceRoot) !== evidenceRoot) {
    throw new Error("Production load evidence root must not traverse a symbolic link.");
  }
  const decisionPath = path3.join(evidenceRoot, "load-gate-decision.json");
  const metadata = await lstat2(decisionPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Production load decision must be a regular file, not a symbolic link.");
  }
  const requiredMode = options.requiredMode === void 0 ? process.platform === "win32" ? null : 288 : options.requiredMode;
  if (requiredMode !== null && (metadata.mode & 511) !== requiredMode) {
    throw new Error(`Production load decision mode must be ${requiredMode.toString(8)}.`);
  }
  const requiredOwnerUid = options.requiredOwnerUid === void 0 && process.platform !== "win32" ? 0 : options.requiredOwnerUid;
  if (requiredOwnerUid !== void 0 && metadata.uid !== requiredOwnerUid) {
    throw new Error("Production load decision owner is invalid.");
  }
  if (metadata.size <= 0 || metadata.size > maximumDecisionBytes) {
    throw new Error("Production load decision size is invalid.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants2.O_NOFOLLOW ?? 0;
  const handle = await open2(decisionPath, constants2.O_RDONLY | noFollow);
  let bytes;
  try {
    const before = await handle.stat();
    if (!sameFile(metadata, before)) {
      throw new Error("Production load decision changed while it was opened.");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameSnapshot2(before, after) || bytes.byteLength !== after.size) {
      throw new Error("Production load decision changed while it was read.");
    }
  } finally {
    await handle.close();
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) {
    throw new Error("Production load decision must not contain a UTF-8 BOM.");
  }
  const text = new TextDecoder3("utf-8", { fatal: true }).decode(bytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Production load decision must be valid JSON.");
  }
  if (`${JSON.stringify(parsed, null, 2)}
` !== text) {
    throw new Error("Production load decision must be canonical two-space JSON with one LF.");
  }
  assertProductionLoadEvidenceSafe(parsed);
  const decision = validateProductionLoadDecision(parsed, options.expectedCandidate);
  return {
    path: decisionPath,
    byteLength: bytes.byteLength,
    sha256: createHash2("sha256").update(bytes).digest("hex"),
    decision
  };
}
async function assertProductionLoadDecisionUnchanged(artifact, options) {
  const current = await readApprovedProductionLoadDecision(options);
  if (current.path !== artifact.path || current.byteLength !== artifact.byteLength || current.sha256 !== artifact.sha256) {
    throw new Error("Production load decision changed after approval was loaded.");
  }
}

// node_modules/pg/esm/index.mjs
var import_lib = __toESM(require_lib2(), 1);
var Client = import_lib.default.Client;
var Pool = import_lib.default.Pool;
var Connection = import_lib.default.Connection;
var types = import_lib.default.types;
var Query = import_lib.default.Query;
var DatabaseError = import_lib.default.DatabaseError;
var escapeIdentifier = import_lib.default.escapeIdentifier;
var escapeLiteral = import_lib.default.escapeLiteral;
var Result = import_lib.default.Result;
var TypeOverrides = import_lib.default.TypeOverrides;
var defaults = import_lib.default.defaults;

// scripts/lib/production-load-host.ts
var faultIds = new Set(
  PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => fault.id)
);

// scripts/lib/production-load-fault-journal.ts
var PRODUCTION_LOAD_FAULT_JOURNAL_MAX_BYTES = 4 * 1024;
var faultIds2 = new Set(PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => fault.id));

// scripts/lib/production-load-linux-backend.ts
var MAXIMUM_OUTPUT_BYTES = 64 * 1024;
var faultIds3 = new Set(PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => fault.id));

// scripts/lib/production-load-run-manifest.ts
import { createHash as createHash3 } from "node:crypto";
import { constants as constants3 } from "node:fs";
import { lstat as lstat3, open as open3, realpath as realpath3 } from "node:fs/promises";
import path4 from "node:path";
import { TextDecoder as TextDecoder4 } from "node:util";
var PRODUCTION_LOAD_RUN_MANIFEST_PATH = "/etc/learncoding/production-load-manifest.json";
var maximumManifestBytes = 64 * 1024;
var manifestFields = [
  "schemaVersion",
  "decisionSha256",
  "candidate",
  "runnerVmId",
  "expectedUnrelatedInventorySha256",
  "validFrom",
  "validUntil"
];
var candidateFields = [
  "gitSha",
  "gitTree",
  "releaseManifestSha256",
  "applicationImageRecordSha256",
  "composeProject",
  "composeWorkdir",
  "publicOrigin",
  "managedInventorySha256",
  "firewallPolicySha256",
  "runnerGuestReleaseSha256",
  "runnerImageRecordSha256",
  "nucHostId",
  "runnerVmId",
  "datasetId"
];
function fail3(code) {
  throw new Error(`Production load run manifest failed: ${code}`);
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function exactOrderedKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}
function canonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail3("invalid_validity_window");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail3("invalid_validity_window");
  }
  return milliseconds;
}
function validateProductionLoadRunManifest(options) {
  const value = record(options.value);
  const expectedCandidate = options.expectedCandidate;
  const candidate = value ? record(value.candidate) : null;
  if (!value || !exactOrderedKeys(value, manifestFields) || value.schemaVersion !== 1 || !candidate || !exactOrderedKeys(candidate, candidateFields) || !exactOrderedKeys(expectedCandidate, candidateFields)) {
    fail3("invalid_schema");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(options.expectedDecisionSha256) || value.decisionSha256 !== options.expectedDecisionSha256) {
    fail3("decision_mismatch");
  }
  for (const field of candidateFields) {
    if (candidate[field] !== expectedCandidate[field]) fail3("candidate_mismatch");
  }
  if (value.runnerVmId !== options.expectedCandidate.runnerVmId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    String(value.runnerVmId)
  )) {
    fail3("runner_vm_mismatch");
  }
  if (typeof value.expectedUnrelatedInventorySha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.expectedUnrelatedInventorySha256)) {
    fail3("invalid_unrelated_inventory");
  }
  const now = options.now.getTime();
  const validFrom = canonicalTimestamp(value.validFrom);
  const validUntil = canonicalTimestamp(value.validUntil);
  if (!Number.isFinite(now) || validUntil <= validFrom || validUntil - validFrom > 24 * 60 * 60 * 1e3 || now < validFrom || (options.validityMode ?? "current") === "current" && now > validUntil) {
    fail3("invalid_validity_window");
  }
  return value;
}
function sameSnapshot3(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function readApprovedProductionLoadRunManifest(options) {
  const manifestPath = path4.resolve(options.manifestPath ?? PRODUCTION_LOAD_RUN_MANIFEST_PATH);
  if (!path4.isAbsolute(manifestPath) || manifestPath === path4.parse(manifestPath).root) {
    fail3("invalid_path");
  }
  if (process.platform !== "win32") {
    let parent;
    try {
      parent = await realpath3(path4.dirname(manifestPath));
    } catch {
      fail3("unsafe_file");
    }
    if (parent !== path4.dirname(manifestPath)) fail3("unsafe_file");
  }
  let metadata;
  try {
    metadata = await lstat3(manifestPath);
  } catch {
    fail3("unsafe_file");
  }
  const requiredMode = options.requiredMode === void 0 ? process.platform === "win32" ? null : 384 : options.requiredMode;
  const requiredOwnerUid = options.requiredOwnerUid === void 0 && process.platform !== "win32" ? 0 : options.requiredOwnerUid;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || requiredMode !== null && (metadata.mode & 511) !== requiredMode || requiredOwnerUid !== void 0 && metadata.uid !== requiredOwnerUid || metadata.size <= 0 || metadata.size > maximumManifestBytes) {
    fail3("unsafe_file");
  }
  const noFollow = process.platform === "win32" ? 0 : constants3.O_NOFOLLOW ?? 0;
  let bytes;
  try {
    const handle = await open3(manifestPath, constants3.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!sameSnapshot3(metadata, before)) fail3("file_changed");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameSnapshot3(before, after) || bytes.byteLength !== after.size) fail3("file_changed");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Production load run manifest failed:")) {
      throw error;
    }
    fail3("unsafe_file");
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) fail3("invalid_encoding");
  let text;
  try {
    text = new TextDecoder4("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail3("invalid_encoding");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail3("invalid_json");
  }
  if (`${JSON.stringify(parsed, null, 2)}
` !== text) fail3("noncanonical_json");
  const manifest = validateProductionLoadRunManifest({
    value: parsed,
    expectedCandidate: options.expectedCandidate,
    expectedDecisionSha256: options.expectedDecisionSha256,
    now: options.now,
    validityMode: options.validityMode
  });
  const sha256 = createHash3("sha256").update(bytes).digest("hex");
  return {
    path: manifestPath,
    byteLength: bytes.byteLength,
    sha256,
    candidateRunIdentitySha256: `sha256:${sha256}`,
    manifest
  };
}
async function assertProductionLoadRunManifestUnchanged(artifact, options) {
  const current = await readApprovedProductionLoadRunManifest(options);
  if (current.path !== artifact.path || current.byteLength !== artifact.byteLength || current.sha256 !== artifact.sha256) {
    fail3("manifest_changed");
  }
}

// scripts/lib/production-load-control-service.ts
function installProductionLoadControlSignalHandlers(options) {
  let triggered = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const remove = () => {
    options.signals.off("SIGTERM", handle);
    options.signals.off("SIGINT", handle);
  };
  const handle = () => {
    if (triggered) return;
    triggered = true;
    remove();
    void options.service.close().then(resolveDone, rejectDone);
  };
  options.signals.once("SIGTERM", handle);
  options.signals.once("SIGINT", handle);
  return { done, remove };
}

// scripts/lib/production-load-fixture-runtime.ts
var PRODUCTION_LOAD_FIXTURE_PROFILE = "codestead-production-load-v1";
var PRODUCTION_LOAD_FIXTURE_ROOT = "/var/lib/learncoding-production-load-fixtures";
var PRODUCTION_LOAD_FIXTURE_RUNTIME_SOCKET = "/run/learncoding-production-load-fixtures/runtime.sock";
var hashPattern = /^sha256:[0-9a-f]{64}$/;
var rawHashPattern = /^[0-9a-f]{64}$/;
var requestIdPattern = /^[A-Za-z0-9._:-]{1,160}$/;
var fixtureFaults = /* @__PURE__ */ new Set([
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert"
]);
function fail4(code) {
  throw new Error(`Production load fixture adapter failed: ${code}`);
}
function abort(signal) {
  if (signal.aborted) fail4("aborted");
}
function isFixtureFault(value) {
  return fixtureFaults.has(value);
}
function exactTestControlTarget(request) {
  return request.target.kind !== "test-control" || request.target.control === request.faultId;
}
function validateConfiguration(environment, context) {
  const expectedInventory = context.expectedUnrelatedInventorySha256;
  if (environment.LOAD_FIXTURE_PROFILE !== PRODUCTION_LOAD_FIXTURE_PROFILE || environment.LOAD_FIXTURE_APPROVED !== "1" || environment.LOAD_FIXTURE_RUN_IDENTITY_SHA256 !== context.candidateRunIdentitySha256 || environment.LOAD_FIXTURE_ROOT !== PRODUCTION_LOAD_FIXTURE_ROOT || environment.LOAD_FIXTURE_RUNTIME_SOCKET !== PRODUCTION_LOAD_FIXTURE_RUNTIME_SOCKET || !hashPattern.test(context.candidateRunIdentitySha256) || !hashPattern.test(context.decisionSha256) || !rawHashPattern.test(expectedInventory) || context.candidate.composeProject !== "learncoding" || context.candidate.composeWorkdir !== "/opt/learncoding" || context.candidate.datasetId !== "seed-20260715") {
    fail4("invalid_fixture_configuration");
  }
  return {
    profile: PRODUCTION_LOAD_FIXTURE_PROFILE,
    project: "learncoding",
    fixtureRoot: PRODUCTION_LOAD_FIXTURE_ROOT,
    runtimeSocket: PRODUCTION_LOAD_FIXTURE_RUNTIME_SOCKET,
    candidate: context.candidate,
    candidateRunIdentitySha256: context.candidateRunIdentitySha256,
    decisionSha256: context.decisionSha256,
    expectedUnrelatedInventorySha256: expectedInventory
  };
}
async function createProductionLoadFixtureRuntimeAdapter(options) {
  const binding = validateConfiguration(options.environment, options.context);
  const startup = new AbortController();
  await options.operations.assertReady(binding, startup.signal).catch(() => {
    fail4("fixture_not_ready");
  });
  let closed = false;
  let closePromise;
  const ready = async (signal) => {
    abort(signal);
    if (closed) fail4("closed");
    try {
      await options.operations.assertReady(binding, signal);
    } catch {
      abort(signal);
      fail4("fixture_not_ready");
    }
    abort(signal);
  };
  return {
    async handle(request, context) {
      if (!requestIdPattern.test(context.requestId)) fail4("invalid_request");
      await ready(context.signal);
      abort(context.signal);
      try {
        if (request.action === "isolation-status") {
          return await options.operations.isolationStatus(context.signal);
        }
        if (request.action === "host-telemetry") {
          return await options.operations.hostTelemetry(context.signal);
        }
        if (request.action === "runner-vm-telemetry") {
          return await options.operations.runnerVmTelemetry(
            request.runnerVmId,
            request.runnerVmMac,
            context.signal
          );
        }
        if (request.action === "browser-journey") {
          await options.operations.browserJourney(
            request.faultId,
            request.stage,
            context.signal
          );
          return { ok: true, faultId: request.faultId, stage: request.stage };
        }
        if (!exactTestControlTarget(request)) fail4("invalid_request");
        if (request.action === "reset") {
          if (!isFixtureFault(request.faultId)) fail4("unsupported_mutation");
          await options.operations.reset(request.faultId, context.signal);
          return null;
        }
        if (request.action === "inject-and-release") {
          if (!isFixtureFault(request.faultId)) fail4("unsupported_mutation");
          await options.operations.injectAndRelease(request.faultId, context.signal);
          return null;
        }
        if (request.action === "probe") {
          return await options.operations.probe(
            request.faultId,
            request.phase,
            context.signal
          );
        }
        return await options.operations.invariantEvidence(
          request.faultId,
          context.signal
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Production load fixture adapter failed:")) {
          throw error;
        }
        abort(context.signal);
        fail4("operation_failed");
      } finally {
        abort(context.signal);
      }
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        try {
          await options.operations.close();
        } catch {
          fail4("close_failed");
        }
      })();
      return closePromise;
    }
  };
}

// scripts/lib/production-load-fixture-operations.ts
import { createHash as createHash4 } from "node:crypto";
import { lstat as lstat4 } from "node:fs/promises";
import { createConnection } from "node:net";
import path5 from "node:path";
var FIXTURE_SOCKET = "/run/learncoding-production-load-fixtures/runtime.sock";
var MAXIMUM_MESSAGE_BYTES = 64 * 1024;
var EXCHANGE_TIMEOUT_MS = 125e3;
var hashPattern2 = /^[0-9a-f]{64}$/;
var timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function fail5(code) {
  throw new Error(`Production load fixture operations failed: ${code}`);
}
function canonical(value) {
  const output = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (output.byteLength > MAXIMUM_MESSAGE_BYTES) fail5("request_too_large");
  return output;
}
function record2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function exactKeys(value, expected) {
  return Object.keys(value).join(",") === expected.join(",");
}
function safeNumber(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function safeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function parseCanonicalResponse(output) {
  if (!Buffer.isBuffer(output) || output.byteLength < 1 || output.byteLength > MAXIMUM_MESSAGE_BYTES) fail5("fixture_operation_failed");
  let value;
  try {
    value = JSON.parse(output.toString("utf8"));
  } catch {
    fail5("fixture_operation_failed");
  }
  if (!output.equals(Buffer.from(JSON.stringify(value) + "\n", "utf8"))) {
    fail5("fixture_operation_failed");
  }
  const envelope = record2(value);
  if (!envelope || !exactKeys(envelope, ["ok", "result"]) || envelope.ok !== true) {
    fail5("fixture_operation_failed");
  }
  return envelope.result;
}
function validateSocketStat(value, kind) {
  if (value.uid !== 65532 || value.gid !== 65532 || value.isSymbolicLink()) {
    fail5("fixture_operation_failed");
  }
  if (kind === "parent") {
    if (!value.isDirectory() || (value.mode & 511) !== 448) {
      fail5("fixture_operation_failed");
    }
    return;
  }
  if (!value.isSocket() || value.nlink !== 1 || (value.mode & 511) !== 384) {
    fail5("fixture_operation_failed");
  }
}
var exchangeUnix = async (request, signal) => {
  if (signal.aborted) fail5("aborted");
  if (request.byteLength < 1 || request.byteLength > MAXIMUM_MESSAGE_BYTES) {
    fail5("fixture_operation_failed");
  }
  let parent;
  let socketStat;
  try {
    [parent, socketStat] = await Promise.all([
      lstat4(path5.posix.dirname(FIXTURE_SOCKET)),
      lstat4(FIXTURE_SOCKET)
    ]);
  } catch {
    fail5("fixture_operation_failed");
  }
  validateSocketStat(parent, "parent");
  validateSocketStat(socketStat, "socket");
  if (signal.aborted) fail5("aborted");
  return new Promise((resolve, reject) => {
    const socket = createConnection(FIXTURE_SOCKET);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error || !response) reject(new Error("fixture_operation_failed"));
      else resolve(response);
    };
    const onAbort = () => finish(new Error("aborted"));
    const timer = setTimeout(
      () => finish(new Error("fixture_operation_failed")),
      EXCHANGE_TIMEOUT_MS
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    socket.once("connect", () => socket.end(request));
    socket.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > MAXIMUM_MESSAGE_BYTES) {
        finish(new Error("fixture_operation_failed"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => finish(void 0, Buffer.concat(chunks, bytes)));
    socket.once("error", () => finish(new Error("fixture_operation_failed")));
  });
};
function validateIsolation(value) {
  const item = record2(value);
  if (!item || !exactKeys(item, ["maintenanceWindowApproved", "freshRecoveryPoint"]) || typeof item.maintenanceWindowApproved !== "boolean" || typeof item.freshRecoveryPoint !== "boolean") fail5("fixture_operation_failed");
  return {
    maintenanceWindowApproved: item.maintenanceWindowApproved,
    freshRecoveryPoint: item.freshRecoveryPoint
  };
}
function validateHostTelemetry(value) {
  const item = record2(value);
  const keys = [
    "hostCpuPercent",
    "availableMemoryBytes",
    "rootFreeFraction",
    "rootFreeBytes",
    "diskReadBytes",
    "diskWriteBytes",
    "temperatureCelsius",
    "oomKills",
    "thermalThrottleIncrements"
  ];
  if (!item || !exactKeys(item, keys) || !safeNumber(item.hostCpuPercent, 0, 100) || !safeInteger(item.availableMemoryBytes) || !safeNumber(item.rootFreeFraction, 0, 1) || !safeInteger(item.rootFreeBytes) || !safeInteger(item.diskReadBytes) || !safeInteger(item.diskWriteBytes) || !safeNumber(item.temperatureCelsius, -100, 250) || !safeInteger(item.oomKills) || !safeInteger(item.thermalThrottleIncrements)) fail5("fixture_operation_failed");
  return item;
}
function validateRunnerTelemetry(value) {
  const item = record2(value);
  if (!item || !exactKeys(item, ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"]) || !safeNumber(item.runnerVmCpuPercent, 0, 100) || !safeInteger(item.runnerVmAvailableMemoryBytes)) fail5("fixture_operation_failed");
  return {
    runnerVmCpuPercent: item.runnerVmCpuPercent,
    runnerVmAvailableMemoryBytes: item.runnerVmAvailableMemoryBytes
  };
}
function validateProbe(value) {
  const item = record2(value);
  if (!item || !exactKeys(item, ["componentHealthy", "alertOrDeadLetterVisible"]) || typeof item.componentHealthy !== "boolean" || typeof item.alertOrDeadLetterVisible !== "boolean") fail5("fixture_operation_failed");
  return {
    componentHealthy: item.componentHealthy,
    alertOrDeadLetterVisible: item.alertOrDeadLetterVisible
  };
}
function validateInvariants(value) {
  const item = record2(value);
  if (!item || !exactKeys(item, [
    "observedAt",
    "acknowledgedMutationFailures",
    "runnerMaxConcurrentJobs",
    "secretLeakFindings"
  ]) || typeof item.observedAt !== "string" || !timestampPattern.test(item.observedAt) || !safeInteger(item.acknowledgedMutationFailures) || item.runnerMaxConcurrentJobs !== 2 || !safeInteger(item.secretLeakFindings)) fail5("fixture_operation_failed");
  return {
    observedAt: item.observedAt,
    acknowledgedMutationFailures: item.acknowledgedMutationFailures,
    runnerMaxConcurrentJobs: 2,
    secretLeakFindings: item.secretLeakFindings
  };
}
function createProductionLoadFixtureUnixOperations(options = {}) {
  const exchange = options.exchange ?? exchangeUnix;
  let bindingSha256 = null;
  let closed = false;
  const call = async (request, signal) => {
    if (closed) fail5("closed");
    if (signal.aborted) fail5("aborted");
    let output;
    try {
      output = await exchange(canonical(request), signal);
    } catch {
      if (signal.aborted) fail5("aborted");
      fail5("fixture_operation_failed");
    }
    if (signal.aborted) fail5("aborted");
    return parseCanonicalResponse(output);
  };
  const readyDigest = () => {
    if (!bindingSha256) fail5("fixture_not_ready");
    return bindingSha256;
  };
  return {
    async assertReady(binding, signal) {
      if (closed) fail5("closed");
      const digest = createHash4("sha256").update(canonical(binding)).digest("hex");
      if (bindingSha256 && bindingSha256 !== digest) fail5("binding_rejected");
      const value = record2(await call({ version: 1, action: "assert-ready", binding }, signal));
      if (!value || !exactKeys(value, ["bindingSha256", "ready"]) || value.bindingSha256 !== digest || value.ready !== true || !hashPattern2.test(digest)) fail5("binding_rejected");
      bindingSha256 = digest;
    },
    async isolationStatus(signal) {
      return validateIsolation(await call({
        version: 1,
        action: "isolation-status",
        bindingSha256: readyDigest()
      }, signal));
    },
    async hostTelemetry(signal) {
      return validateHostTelemetry(await call({
        version: 1,
        action: "host-telemetry",
        bindingSha256: readyDigest()
      }, signal));
    },
    async runnerVmTelemetry(runnerVmId, runnerVmMac, signal) {
      return validateRunnerTelemetry(await call({
        version: 1,
        action: "runner-vm-telemetry",
        bindingSha256: readyDigest(),
        runnerVmId,
        runnerVmMac
      }, signal));
    },
    async reset(faultId, signal) {
      const value = await call({
        version: 1,
        action: "reset",
        bindingSha256: readyDigest(),
        faultId
      }, signal);
      if (value !== null) fail5("fixture_operation_failed");
    },
    async injectAndRelease(faultId, signal) {
      const value = await call({
        version: 1,
        action: "inject-and-release",
        bindingSha256: readyDigest(),
        faultId
      }, signal);
      if (value !== null) fail5("fixture_operation_failed");
    },
    async probe(faultId, phase, signal) {
      return validateProbe(await call({
        version: 1,
        action: "probe",
        bindingSha256: readyDigest(),
        faultId,
        phase
      }, signal));
    },
    async browserJourney(faultId, stage, signal) {
      const value = await call({
        version: 1,
        action: "browser-journey",
        bindingSha256: readyDigest(),
        faultId,
        stage
      }, signal);
      if (value !== null) fail5("fixture_operation_failed");
    },
    async invariantEvidence(faultId, signal) {
      return validateInvariants(await call({
        version: 1,
        action: "invariant-evidence",
        bindingSha256: readyDigest(),
        faultId
      }, signal));
    },
    async close() {
      closed = true;
    }
  };
}

// scripts/lib/production-load-test-control-service.ts
import { lstat as lstat6 } from "node:fs/promises";
import path7 from "node:path";

// scripts/lib/production-load-test-control-server.ts
import { createHash as createHash5 } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, chown, lstat as lstat5, unlink as unlink2 } from "node:fs/promises";
import { createConnection as createConnection2, createServer } from "node:net";
import path6 from "node:path";
var MAXIMUM_MESSAGE_BYTES2 = 64 * 1024;
var MAXIMUM_PEER_CREDENTIAL_BYTES = 256;
var PEER_CREDENTIAL_TIMEOUT_MS = 2e3;
var PEER_CREDENTIAL_HELPER = "/opt/learncoding/infra/ops/production-load-peer-credentials.py";
var PYTHON_INTERPRETER = "/usr/bin/python3.12";
var PRODUCTION_LOAD_TEST_CONTROL_SOCKET = "/run/learncoding/codestead-production-load-test-control.sock";
var VM_MAC = "52:54:00:20:00:12";
var RUNNER_DOMAIN = "codestead-runner";
var RUNNER_UNIT = "learncoding-runner.service";
var REPOSITORY_ROOT = "/opt/learncoding";
var RUNNER_STATE_ROOT = "/var/lib/learncoding-runner";
var serviceTargets = {
  app_container_restart: "app",
  email_worker_restart: "mail-worker",
  assessment_regrade_worker_restart: "regrade-worker",
  project_review_correction_worker_restart: "project-review-correction-worker",
  exam_finalization_worker_restart: "exam-finalization-worker",
  practice_recovery_worker_restart: "practice-runner-recovery-worker",
  rewards_worker_restart: "reward-worker"
};
var testControlFaultIds = /* @__PURE__ */ new Set([
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert"
]);
var faultIds4 = /* @__PURE__ */ new Set([
  "runner_service_restart",
  ...Object.keys(serviceTargets),
  ...testControlFaultIds
]);
var mutationFaultIds = /* @__PURE__ */ new Set([
  "runner_service_restart",
  ...testControlFaultIds
]);
var vmIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var runIdentityPattern = /^sha256:[0-9a-f]{64}$/;
var timestampPattern2 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function fail6(code) {
  throw new Error(`Production load test control failed: ${code}`);
}
function record3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function exactKeys2(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function canonical2(value) {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}
function stableFailure() {
  return canonical2({ ok: false, result: null });
}
function targetFor(faultId) {
  const service = serviceTargets[faultId];
  if (service) return { kind: "compose-service", service };
  if (faultId === "runner_service_restart") {
    return { kind: "runner-service", domain: RUNNER_DOMAIN, unit: RUNNER_UNIT };
  }
  if (testControlFaultIds.has(faultId)) {
    return { kind: "test-control", control: faultId };
  }
  return null;
}
function exactTarget(value, expected) {
  const item = record3(value);
  if (!item) return false;
  if (expected.kind === "compose-service") {
    return exactKeys2(item, ["kind", "service"]) && item.kind === expected.kind && item.service === expected.service;
  }
  if (expected.kind === "runner-service") {
    return exactKeys2(item, ["kind", "domain", "unit"]) && item.kind === expected.kind && item.domain === expected.domain && item.unit === expected.unit;
  }
  return exactKeys2(item, ["kind", "control"]) && item.kind === expected.kind && item.control === expected.control;
}
function parseRequest(body, authority) {
  if (body.byteLength < 2 || body.byteLength > MAXIMUM_MESSAGE_BYTES2) fail6("invalid_request");
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) {
      fail6("invalid_request");
    }
    value = JSON.parse(text);
  } catch {
    fail6("invalid_request");
  }
  if (!Buffer.from(JSON.stringify(value) + "\n", "utf8").equals(body)) {
    fail6("noncanonical_request");
  }
  const item = record3(value);
  if (!item || item.version !== 1 || typeof item.action !== "string") {
    fail6("invalid_request");
  }
  if (item.action === "host-telemetry") {
    if (!exactKeys2(item, ["version", "action", "project"]) || item.project !== authority.project) fail6("unauthorized_request");
    return item;
  }
  if (item.action === "isolation-status") {
    if (!exactKeys2(item, [
      "version",
      "action",
      "project",
      "repositoryRoot",
      "runnerStateRoot",
      "runnerVmId",
      "runnerVmMac"
    ]) || item.project !== authority.project || item.repositoryRoot !== REPOSITORY_ROOT || item.runnerStateRoot !== RUNNER_STATE_ROOT || item.runnerVmId !== authority.runnerVmId || item.runnerVmMac !== authority.runnerVmMac) fail6("unauthorized_request");
    return item;
  }
  if (item.action === "runner-vm-telemetry") {
    if (!exactKeys2(item, [
      "version",
      "action",
      "runnerDomain",
      "runnerVmId",
      "runnerVmMac"
    ]) || item.runnerDomain !== RUNNER_DOMAIN || item.runnerVmId !== authority.runnerVmId || item.runnerVmMac !== authority.runnerVmMac) fail6("unauthorized_request");
    return item;
  }
  if (item.action === "browser-journey") {
    if (!exactKeys2(item, ["version", "action", "faultId", "stage", "project"]) || typeof item.faultId !== "string" || !faultIds4.has(item.faultId) || item.stage !== "steady" && item.stage !== "recovered" || item.project !== authority.project) fail6("unauthorized_request");
    return item;
  }
  if (item.action !== "reset" && item.action !== "inject-and-release" && item.action !== "probe" && item.action !== "invariant-evidence") fail6("invalid_action");
  const expectedKeys = item.action === "probe" ? ["version", "action", "faultId", "target", "phase", "project", "runnerVmId", "runnerVmMac"] : ["version", "action", "faultId", "target", "project", "runnerVmId", "runnerVmMac"];
  const expectedTarget = typeof item.faultId === "string" ? targetFor(item.faultId) : null;
  if (!exactKeys2(item, expectedKeys) || typeof item.faultId !== "string" || !faultIds4.has(item.faultId) || !expectedTarget || !exactTarget(item.target, expectedTarget) || item.project !== authority.project || item.runnerVmId !== authority.runnerVmId || item.runnerVmMac !== authority.runnerVmMac || item.action === "probe" && item.phase !== "baseline" && item.phase !== "recovery" || (item.action === "reset" || item.action === "inject-and-release") && !mutationFaultIds.has(item.faultId)) {
    fail6("unauthorized_request");
  }
  return item;
}
function safeInteger2(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function finite(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function validateResult(request, value) {
  if (request.action === "reset" || request.action === "inject-and-release") {
    if (value !== null) fail6("invalid_result");
    return null;
  }
  const item = record3(value);
  if (!item) fail6("invalid_result");
  if (request.action === "isolation-status") {
    if (!exactKeys2(item, ["maintenanceWindowApproved", "freshRecoveryPoint"]) || typeof item.maintenanceWindowApproved !== "boolean" || typeof item.freshRecoveryPoint !== "boolean") fail6("invalid_result");
  } else if (request.action === "host-telemetry") {
    if (!exactKeys2(item, [
      "hostCpuPercent",
      "availableMemoryBytes",
      "rootFreeFraction",
      "rootFreeBytes",
      "diskReadBytes",
      "diskWriteBytes",
      "temperatureCelsius",
      "oomKills",
      "thermalThrottleIncrements"
    ]) || !finite(item.hostCpuPercent, 0, 100) || !safeInteger2(item.availableMemoryBytes) || !finite(item.rootFreeFraction, 0, 1) || !safeInteger2(item.rootFreeBytes) || !safeInteger2(item.diskReadBytes) || !safeInteger2(item.diskWriteBytes) || !finite(item.temperatureCelsius, -100, 200) || !safeInteger2(item.oomKills) || !safeInteger2(item.thermalThrottleIncrements)) fail6("invalid_result");
  } else if (request.action === "runner-vm-telemetry") {
    if (!exactKeys2(item, ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"]) || !finite(item.runnerVmCpuPercent, 0, 100) || !safeInteger2(item.runnerVmAvailableMemoryBytes)) fail6("invalid_result");
  } else if (request.action === "probe") {
    if (!exactKeys2(item, ["componentHealthy", "alertOrDeadLetterVisible"]) || typeof item.componentHealthy !== "boolean" || typeof item.alertOrDeadLetterVisible !== "boolean") fail6("invalid_result");
  } else if (request.action === "invariant-evidence") {
    if (!exactKeys2(item, [
      "observedAt",
      "acknowledgedMutationFailures",
      "runnerMaxConcurrentJobs",
      "secretLeakFindings"
    ]) || typeof item.observedAt !== "string" || !timestampPattern2.test(item.observedAt) || new Date(item.observedAt).toISOString() !== item.observedAt || !safeInteger2(item.acknowledgedMutationFailures) || !safeInteger2(item.runnerMaxConcurrentJobs) || !safeInteger2(item.secretLeakFindings)) fail6("invalid_result");
  } else if (request.action === "browser-journey") {
    if (!exactKeys2(item, ["ok", "faultId", "stage"]) || item.ok !== true || item.faultId !== request.faultId || item.stage !== request.stage) fail6("invalid_result");
  } else {
    fail6("invalid_result");
  }
  return item;
}
function validateAuthority(authority) {
  if (!runIdentityPattern.test(authority.candidateRunIdentitySha256) || authority.project !== "learncoding" || !vmIdPattern.test(authority.runnerVmId) || authority.runnerVmMac !== VM_MAC) fail6("invalid_authority");
}
function validateProductionLoadTestControlRuntimeDirectory(value) {
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== 0 || value.gid !== 0 || value.nlink < 2 || (value.mode & 18) !== 0 || (value.mode & 64) === 0) {
    fail6("unsafe_runtime_directory");
  }
}
function validateProductionLoadTestControlSocketDirectory(value, expectedGid) {
  if (!Number.isSafeInteger(expectedGid) || expectedGid < 0 || !value.isDirectory() || value.isSymbolicLink() || value.uid !== 0 || value.gid !== expectedGid || value.nlink < 2 || (value.mode & 23) !== 0) fail6("unsafe_socket_parent");
}
function validateProductionLoadTestControlSocket(value) {
  if (!value.isSocket() || value.isSymbolicLink() || value.uid !== 0 || value.gid !== 0 || value.nlink !== 1 || (value.mode & 511) !== 384) fail6("unsafe_socket");
}
function createProductionLoadTestControlDispatcher(options) {
  validateAuthority(options.authority);
  if (!Number.isSafeInteger(options.maximumConcurrentRequests) || options.maximumConcurrentRequests < 1 || options.maximumConcurrentRequests > 2) fail6("invalid_concurrency");
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 125e3) fail6("invalid_timeout");
  let active = 0;
  const inFlight = /* @__PURE__ */ new Map();
  const faultInFlight = /* @__PURE__ */ new Map();
  const mutationState = /* @__PURE__ */ new Map();
  const execute = (request, requestId, callerSignal, onSettled) => {
    const mutationFaultId = request.action === "reset" || request.action === "inject-and-release" ? request.faultId : null;
    const controller = new AbortController();
    const relay = () => controller.abort();
    callerSignal?.addEventListener("abort", relay, { once: true });
    if (callerSignal?.aborted) relay();
    const deadline = setTimeout(relay, options.requestTimeoutMs);
    deadline.unref();
    const operation = (async () => {
      try {
        if (controller.signal.aborted) fail6("aborted");
        await options.assertAuthority?.();
        if (controller.signal.aborted) fail6("aborted");
        const raw = await options.adapter.handle(request, {
          requestId,
          signal: controller.signal
        });
        if (controller.signal.aborted) fail6("aborted");
        const result = validateResult(request, raw);
        await options.assertAuthority?.();
        const response = canonical2({ ok: true, result });
        if (request.action === "reset" || request.action === "inject-and-release") {
          mutationState.set(request.faultId, {
            action: request.action,
            response,
            outcome: "success"
          });
        }
        return response;
      } catch {
        const response = stableFailure();
        if (mutationFaultId !== null && (request.action === "reset" || request.action === "inject-and-release")) {
          mutationState.set(mutationFaultId, {
            action: request.action,
            response,
            outcome: "indeterminate"
          });
        }
        return response;
      } finally {
        clearTimeout(deadline);
        callerSignal?.removeEventListener("abort", relay);
      }
    })();
    const failure = stableFailure();
    let failIndeterminate;
    const deadlineResponse = new Promise((resolve) => {
      failIndeterminate = () => {
        if (mutationFaultId !== null && (request.action === "reset" || request.action === "inject-and-release")) {
          mutationState.set(mutationFaultId, {
            action: request.action,
            response: failure,
            outcome: "indeterminate"
          });
        }
        resolve(failure);
      };
      if (controller.signal.aborted) {
        failIndeterminate();
        return;
      }
      controller.signal.addEventListener("abort", failIndeterminate, { once: true });
    });
    void operation.finally(() => {
      active -= 1;
      if (failIndeterminate) {
        controller.signal.removeEventListener("abort", failIndeterminate);
      }
      onSettled?.();
    });
    return Promise.race([operation, deadlineResponse]);
  };
  const dispatch = async (input) => {
    if (input.peerUid !== 0) return stableFailure();
    let request;
    try {
      request = parseRequest(input.body, options.authority);
    } catch {
      return stableFailure();
    }
    const requestId = createHash5("sha256").update(options.authority.candidateRunIdentitySha256 + "\0").update(input.body).digest("hex");
    const mutationFaultId = request.action === "reset" || request.action === "inject-and-release" ? request.faultId : null;
    if (mutationFaultId !== null) {
      const existing = inFlight.get(requestId);
      if (existing) return existing;
      if (faultInFlight.has(mutationFaultId)) return stableFailure();
      const state = mutationState.get(mutationFaultId);
      if (state?.action === request.action) {
        if (state.outcome === "success" || request.action === "inject-and-release") {
          return state.response;
        }
      } else if (request.action === "inject-and-release" && state?.action === "reset" && state.outcome === "indeterminate") {
        return stableFailure();
      }
    }
    if (active >= options.maximumConcurrentRequests) return stableFailure();
    active += 1;
    const pending = execute(request, requestId, input.signal, () => {
      if (mutationFaultId === null) return;
      if (faultInFlight.get(mutationFaultId) === requestId) {
        faultInFlight.delete(mutationFaultId);
      }
      if (inFlight.get(requestId) === pending) inFlight.delete(requestId);
    });
    if (mutationFaultId !== null) {
      inFlight.set(requestId, pending);
      faultInFlight.set(mutationFaultId, requestId);
    }
    return pending;
  };
  return { dispatch };
}
function validPeerCredentialInteger(value, allowZero) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) && value <= 2147483647;
}
function parseProductionLoadPeerCredentials(output) {
  if (!Buffer.isBuffer(output) || output.byteLength < 1 || output.byteLength > MAXIMUM_PEER_CREDENTIAL_BYTES) {
    fail6("invalid_peer_credentials");
  }
  let value;
  try {
    value = JSON.parse(output.toString("utf8"));
  } catch {
    fail6("invalid_peer_credentials");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail6("invalid_peer_credentials");
  }
  const candidate = value;
  if (Object.keys(candidate).join(",") !== "pid,uid,gid" || !validPeerCredentialInteger(candidate.pid, false) || !validPeerCredentialInteger(candidate.uid, true) || !validPeerCredentialInteger(candidate.gid, true)) {
    fail6("invalid_peer_credentials");
  }
  const credentials = {
    pid: candidate.pid,
    uid: candidate.uid,
    gid: candidate.gid
  };
  if (!output.equals(Buffer.from(JSON.stringify(credentials) + "\n", "utf8"))) {
    fail6("invalid_peer_credentials");
  }
  return credentials;
}
async function validatePeerCredentialExecutable(target, executable) {
  let stat;
  try {
    stat = await lstat5(target);
  } catch {
    fail6("peer_credentials_unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 18) !== 0 || executable && (stat.mode & 73) === 0) {
    fail6("peer_credentials_unavailable");
  }
}
function collectProductionLoadPeerCredentialsOnChildClose(child, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    let errorBytes = 0;
    const chunks = [];
    const rejectStable = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("peer_credentials_unavailable"));
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      rejectStable();
    };
    const timer = setTimeout(onAbort, PEER_CREDENTIAL_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    if (!child.stdout || !child.stderr) {
      rejectStable();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      outputBytes += chunk.byteLength;
      if (outputBytes > MAXIMUM_PEER_CREDENTIAL_BYTES) {
        child.kill("SIGKILL");
        rejectStable();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (raw) => {
      errorBytes += Buffer.byteLength(raw);
      child.kill("SIGKILL");
      rejectStable();
    });
    child.once("error", rejectStable);
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      if (code !== 0 || exitSignal !== null || errorBytes !== 0) {
        rejectStable();
        return;
      }
      try {
        const credentials = parseProductionLoadPeerCredentials(
          Buffer.concat(chunks, outputBytes)
        );
        settled = true;
        cleanup();
        resolve(credentials);
      } catch {
        rejectStable();
      }
    });
  });
}
var resolveProductionLoadPeerCredentials = async (socket, signal) => {
  if (signal.aborted || socket.destroyed) fail6("peer_credentials_unavailable");
  await Promise.all([
    validatePeerCredentialExecutable(PYTHON_INTERPRETER, true),
    validatePeerCredentialExecutable(PEER_CREDENTIAL_HELPER, false)
  ]);
  if (signal.aborted || socket.destroyed) fail6("peer_credentials_unavailable");
  let child;
  try {
    child = spawn(PYTHON_INTERPRETER, [PEER_CREDENTIAL_HELPER], {
      cwd: REPOSITORY_ROOT,
      env: { LANG: "C", LC_ALL: "C", NODE_ENV: "production", PATH: "/usr/bin:/bin" },
      shell: false,
      windowsHide: true,
      stdio: [socket, "pipe", "pipe"]
    });
  } catch {
    fail6("peer_credentials_unavailable");
  }
  return collectProductionLoadPeerCredentialsOnChildClose(child, signal);
};
async function runProductionLoadTestControlAfterPeerAuthorization(options) {
  let credentials;
  try {
    if (options.signal.aborted) fail6("peer_unauthorized");
    credentials = await options.resolvePeerCredentials(options.socket, options.signal);
    if (options.signal.aborted || !validPeerCredentialInteger(credentials.pid, false) || !validPeerCredentialInteger(credentials.uid, true) || !validPeerCredentialInteger(credentials.gid, true) || credentials.uid !== 0) {
      fail6("peer_unauthorized");
    }
  } catch {
    fail6("peer_unauthorized");
  }
  return options.authorized(credentials.uid);
}
function safeSocketPath(value) {
  if (value !== PRODUCTION_LOAD_TEST_CONTROL_SOCKET || !path6.posix.isAbsolute(value) || path6.posix.normalize(value) !== value || /[\0\r\n]/.test(value)) fail6("invalid_socket_path");
  return value;
}
function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
function socketIsActive(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection2(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}
async function prepareSocketPath(socketPath, parentGid) {
  let runtimeDirectory;
  try {
    runtimeDirectory = await lstat5("/run");
  } catch {
    fail6("unsafe_runtime_directory");
  }
  validateProductionLoadTestControlRuntimeDirectory(runtimeDirectory);
  let parent;
  try {
    parent = await lstat5(path6.dirname(socketPath));
  } catch {
    fail6("unsafe_socket_parent");
  }
  validateProductionLoadTestControlSocketDirectory(parent, parentGid);
  let existing;
  try {
    existing = await lstat5(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    fail6("unsafe_socket");
  }
  validateProductionLoadTestControlSocket(existing);
  let active = false;
  try {
    active = await socketIsActive(socketPath);
  } catch {
    fail6("unsafe_socket");
  }
  if (active) fail6("socket_in_use");
  try {
    await unlink2(socketPath);
  } catch {
    fail6("unsafe_socket");
  }
}
async function startProductionLoadTestControlUnixServer(options) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const gid = options.gid ?? process.getgid?.() ?? -1;
  if (platform !== "linux" || uid !== 0 || gid !== 0) fail6("linux_root_required");
  const socketPath = safeSocketPath(options.socketPath);
  if (!Number.isSafeInteger(options.socketParentGid) || options.socketParentGid < 0) {
    fail6("invalid_socket_parent_gid");
  }
  const maximumConcurrentRequests = options.maximumConcurrentRequests ?? 2;
  const requestTimeoutMs = options.requestTimeoutMs ?? 125e3;
  const peerCredentialResolver = options.resolvePeerCredentials ?? resolveProductionLoadPeerCredentials;
  const dispatcher = createProductionLoadTestControlDispatcher({
    adapter: options.adapter,
    authority: options.authority,
    maximumConcurrentRequests,
    ...options.assertAuthority ? { assertAuthority: options.assertAuthority } : {},
    requestTimeoutMs
  });
  await prepareSocketPath(socketPath, options.socketParentGid);
  let closing = false;
  const sockets = /* @__PURE__ */ new Set();
  const controllers = /* @__PURE__ */ new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    controllers.add(controller);
    const chunks = [];
    let bytes = 0;
    let requestEnded = false;
    let responseStarted = false;
    socket.pause();
    const finish = () => {
      sockets.delete(socket);
      controllers.delete(controller);
    };
    const abort2 = () => controller.abort();
    socket.setTimeout(requestTimeoutMs, () => {
      abort2();
      socket.destroy();
    });
    socket.once("error", abort2);
    socket.once("close", () => {
      if (!requestEnded || responseStarted && !socket.writableFinished) abort2();
      finish();
    });
    void runProductionLoadTestControlAfterPeerAuthorization({
      socket,
      signal: controller.signal,
      resolvePeerCredentials: peerCredentialResolver,
      authorized: (peerUid) => {
        if (closing || socket.destroyed || controller.signal.aborted) {
          fail6("peer_unauthorized");
        }
        socket.on("data", (raw) => {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          bytes += chunk.byteLength;
          if (bytes > MAXIMUM_MESSAGE_BYTES2) {
            abort2();
            socket.end(stableFailure());
            return;
          }
          chunks.push(chunk);
        });
        socket.once("end", () => {
          requestEnded = true;
          if (bytes > MAXIMUM_MESSAGE_BYTES2) return;
          responseStarted = true;
          void dispatcher.dispatch({
            body: Buffer.concat(chunks, bytes),
            peerUid,
            signal: controller.signal
          }).then(
            (response) => {
              if (!socket.destroyed) socket.end(response);
            },
            () => {
              if (!socket.destroyed) socket.end(stableFailure());
            }
          );
        });
        socket.resume();
      }
    }).catch(() => {
      abort2();
      if (!socket.destroyed) socket.end(stableFailure());
    });
  });
  server.maxConnections = maximumConcurrentRequests;
  try {
    await listen(server, socketPath);
    await chown(socketPath, 0, 0);
    await chmod(socketPath, 384);
    const parent = await lstat5(path6.dirname(socketPath));
    validateProductionLoadTestControlSocketDirectory(parent, options.socketParentGid);
    const created = await lstat5(socketPath);
    validateProductionLoadTestControlSocket(created);
    let closed = false;
    return {
      socketPath,
      async close() {
        if (closed) return;
        closed = true;
        closing = true;
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
        try {
          const current = await lstat5(socketPath);
          if (current.isSocket() && !current.isSymbolicLink() && current.uid === 0 && current.gid === 0 && current.nlink === 1 && current.dev === created.dev && current.ino === created.ino) {
            await unlink2(socketPath);
          }
        } catch (error) {
          if (error.code !== "ENOENT") fail6("shutdown_failed");
        }
        try {
          await options.adapter.close?.();
        } catch {
          fail6("shutdown_failed");
        }
      }
    };
  } catch {
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    await closeServer(server).catch(() => void 0);
    try {
      const current = await lstat5(socketPath);
      if (current.isSocket() && !current.isSymbolicLink() && current.uid === 0 && current.gid === 0 && current.nlink === 1 && (current.mode & 511) === 384) {
        await unlink2(socketPath);
      }
    } catch {
    }
    fail6("listen_failed");
  }
}

// scripts/lib/production-load-test-control-service.ts
var PRODUCTION_LOAD_CONTROL_SOCKET = "/run/learncoding/load-control.sock";
var RUNNER_VM_MAC = "52:54:00:20:00:12";
function fail7(code) {
  throw new Error(`Production load test-control service failed: ${code}`);
}
function isServiceError(error) {
  return error instanceof Error && error.message.startsWith("Production load test-control service failed:");
}
function safeGroups(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 256 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail7("invalid_supplementary_groups");
  }
  return values;
}
function createProductionLoadTestControlServiceDependencies(createAdapter) {
  return {
    readActiveRelease: readProductionLoadActiveRelease,
    assertActiveReleaseUnchanged: assertProductionLoadActiveReleaseUnchanged,
    readDecision: readApprovedProductionLoadDecision,
    assertDecisionUnchanged: assertProductionLoadDecisionUnchanged,
    readRunManifest: readApprovedProductionLoadRunManifest,
    assertRunManifestUnchanged: assertProductionLoadRunManifestUnchanged,
    inspectSocketParent: lstat6,
    getSupplementaryGroups: () => process.getgroups?.() ?? [],
    createAdapter,
    startServer: startProductionLoadTestControlUnixServer
  };
}
async function startProductionLoadTestControlService(options) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const gid = options.gid ?? process.getegid?.() ?? -1;
  if (platform !== "linux" || uid !== 0 || gid !== 0) fail7("linux_root_required");
  if (options.repositoryRoot !== "/opt/learncoding") fail7("invalid_repository_root");
  const dependencies = options.dependencies;
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  let adapter;
  let server;
  let startupComplete = false;
  try {
    const config = resolveProductionLoadConfig(options.environment, options.repositoryRoot);
    if (options.environment.LOAD_ACTIVE_RELEASE_PATH !== PRODUCTION_LOAD_ACTIVE_RELEASE_PATH) {
      fail7("invalid_active_release_path");
    }
    if (options.environment.LOAD_CONTROL_SOCKET !== PRODUCTION_LOAD_CONTROL_SOCKET) {
      fail7("invalid_control_socket");
    }
    const activeReleaseOptions = {
      activeReleasePath: config.activeReleasePath
    };
    const activeRelease = await dependencies.readActiveRelease(activeReleaseOptions);
    const candidate = buildProductionLoadCandidateFromActiveRelease(
      activeRelease.text,
      config.nucHostId,
      config.runnerVmId
    );
    if (candidate.publicOrigin !== config.baseUrl.origin) fail7("candidate_origin_mismatch");
    const decisionOptions = {
      evidenceRoot: config.evidenceRoot,
      expectedCandidate: candidate
    };
    const decision = await dependencies.readDecision(decisionOptions);
    const decisionSha256 = `sha256:${decision.sha256}`;
    const runManifestOptions = () => ({
      expectedCandidate: candidate,
      expectedDecisionSha256: decisionSha256,
      now: now()
    });
    const runManifest = await dependencies.readRunManifest(runManifestOptions());
    const parentPath = path7.posix.dirname(PRODUCTION_LOAD_TEST_CONTROL_SOCKET);
    const parent = await dependencies.inspectSocketParent(parentPath);
    try {
      validateProductionLoadTestControlSocketDirectory(parent, parent.gid);
    } catch {
      fail7("unsafe_socket_parent");
    }
    const groups = safeGroups(dependencies.getSupplementaryGroups());
    if (!groups.includes(parent.gid)) fail7("unsafe_socket_parent");
    const assertRuntimeAuthority = async () => {
      await dependencies.assertActiveReleaseUnchanged(activeRelease, activeReleaseOptions);
      await dependencies.assertDecisionUnchanged(decision, decisionOptions);
      await dependencies.assertRunManifestUnchanged(runManifest, runManifestOptions());
    };
    adapter = await dependencies.createAdapter({
      candidate,
      candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
      decisionSha256,
      expectedUnrelatedInventorySha256: runManifest.manifest.expectedUnrelatedInventorySha256
    });
    await assertRuntimeAuthority();
    server = await dependencies.startServer({
      socketPath: PRODUCTION_LOAD_TEST_CONTROL_SOCKET,
      socketParentGid: parent.gid,
      authority: {
        candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
        project: "learncoding",
        runnerVmId: config.runnerVmId,
        runnerVmMac: RUNNER_VM_MAC
      },
      adapter,
      assertAuthority: assertRuntimeAuthority,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 125e3,
      platform,
      uid,
      gid
    });
    startupComplete = true;
    let closePromise;
    return {
      socketPath: server.socketPath,
      candidateRunIdentitySha256: runManifest.candidateRunIdentitySha256,
      decisionSha256,
      close() {
        closePromise ??= (async () => {
          try {
            await server.close();
            await assertRuntimeAuthority();
          } catch {
            fail7("shutdown_failed");
          }
        })();
        return closePromise;
      }
    };
  } catch (error) {
    if (!startupComplete) {
      try {
        if (server) await server.close();
        else await adapter?.close?.();
      } catch {
      }
    }
    if (isServiceError(error)) throw error;
    fail7("startup_failed");
  }
}

// scripts/start-production-load-test-control-service.ts
function fail8(code) {
  throw new Error(`Production load test-control entrypoint failed: ${code}`);
}
async function createProductionLoadTestControlRuntimeAdapter(options) {
  const dependencies = options.dependencies ?? {
    createOperations: createProductionLoadFixtureUnixOperations,
    createAdapter: createProductionLoadFixtureRuntimeAdapter
  };
  const operations = dependencies.createOperations();
  return dependencies.createAdapter({
    environment: {
      ...options.environment,
      LOAD_FIXTURE_RUN_IDENTITY_SHA256: options.context.candidateRunIdentitySha256
    },
    context: options.context,
    operations
  });
}
async function runProductionLoadTestControlServiceEntrypoint(options = {}) {
  const environment = options.environment ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.length !== 0) fail8("invalid_arguments");
  const dependencies = options.dependencies ?? createProductionLoadTestControlServiceDependencies(
    (context) => createProductionLoadTestControlRuntimeAdapter({
      environment,
      context
    })
  );
  const serviceOptions = {
    environment,
    repositoryRoot: "/opt/learncoding",
    dependencies
  };
  const service = await (options.startService ?? startProductionLoadTestControlService)(
    serviceOptions
  );
  const installed = installProductionLoadControlSignalHandlers({
    service,
    signals: options.signals ?? process
  });
  try {
    await installed.done;
  } finally {
    installed.remove();
  }
}
var currentModulePath = fileURLToPath(import.meta.url);
var launchedPath = process.argv[1] ? path8.resolve(process.argv[1]) : "";
if (launchedPath === currentModulePath) {
  void runProductionLoadTestControlServiceEntrypoint().catch(() => {
    process.stderr.write("Production load test-control service failed.\n");
    process.exitCode = 1;
  });
}
export {
  createProductionLoadTestControlRuntimeAdapter,
  runProductionLoadTestControlServiceEntrypoint
};
