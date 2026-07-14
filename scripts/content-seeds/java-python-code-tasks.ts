export interface JavaPythonCodeTask {
  readonly prompt: string;
  readonly starterCode: string;
  readonly referenceSolution: string;
  readonly explanation: string;
  readonly tests: readonly {
    readonly stdin: string;
    readonly expectedStdout: string;
    readonly category: "normal" | "boundary";
  }[];
}

const JAVA_STARTER = `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);
        // TODO: implement the stated input/output contract.
    }
}
`;

const PYTHON_STARTER = `import sys

def solve(data: str) -> str:
    # TODO: implement the stated input/output contract.
    return ""

if __name__ == "__main__":
    print(solve(sys.stdin.read()), end="")
`;

type TaskTest = JavaPythonCodeTask["tests"][number];

function normal(stdin: string, expectedStdout: string): TaskTest {
  return { stdin, expectedStdout, category: "normal" };
}

function boundary(stdin: string, expectedStdout: string): TaskTest {
  return { stdin, expectedStdout, category: "boundary" };
}

function javaTask(
  prompt: string,
  supportCode: string,
  mainBody: string,
  explanation: string,
  tests: readonly TaskTest[],
): JavaPythonCodeTask {
  return {
    prompt,
    starterCode: JAVA_STARTER,
    referenceSolution: `import java.util.*;
import java.util.stream.*;

public class Main {
${supportCode}
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);
${mainBody}
    }
}
`,
    explanation,
    tests,
  };
}

function pythonTask(
  prompt: string,
  solveBody: string,
  explanation: string,
  tests: readonly TaskTest[],
  prelude = "",
): JavaPythonCodeTask {
  return {
    prompt,
    starterCode: PYTHON_STARTER,
    referenceSolution: `import sys
${prelude}
def solve(data: str) -> str:
${solveBody}

if __name__ == "__main__":
    print(solve(sys.stdin.read()), end="")
`,
    explanation,
    tests,
  };
}

const JAVA_TASKS = {
  "java.fundamentals.primitives": javaTask(
    "Read an integer count and a decimal measurement. Print the incremented count and measurement plus 0.5, with one decimal place.",
    "",
    "        int count = input.nextInt();\n        double measurement = input.nextDouble();\n        System.out.printf(\"%d %.1f%n\", count + 1, measurement + 0.5);",
    "The solution uses distinct primitive types for an exact count and an approximate measurement, initializes both locals, and formats the declared result.",
    [normal("3 2.5\n", "4 3.0"), boundary("0 -0.5\n", "1 0.0")],
  ),
  "java.fundamentals.expressions": javaTask(
    "Read two positive integers a and b. Print integer division a / b, then floating division to two decimal places.",
    "",
    "        int a = input.nextInt();\n        int b = input.nextInt();\n        System.out.printf(\"%d %.2f%n\", a / b, a / (double) b);",
    "The reference traces integer division first and explicitly converts one operand before the floating operation.",
    [normal("5 2\n", "2 2.50"), boundary("1 4\n", "0 0.25")],
  ),
  "java.fundamentals.selection": javaTask(
    "Read a score from 0 to 100 and print invalid, fail, pass, or distinction using boundaries 0, 50, and 80.",
    "",
    "        int score = input.nextInt();\n        String label;\n        if (score < 0 || score > 100) label = \"invalid\";\n        else if (score < 50) label = \"fail\";\n        else if (score < 80) label = \"pass\";\n        else label = \"distinction\";\n        System.out.println(label);",
    "The branch order makes invalid input explicit and covers every score boundary exactly once.",
    [normal("79\n", "pass"), boundary("80\n", "distinction")],
  ),
  "java.fundamentals.iteration": javaTask(
    "Read a non-negative n and print the sum of integers from 1 through n using a terminating loop.",
    "",
    "        int n = input.nextInt();\n        long total = 0;\n        for (int value = 1; value <= n; value++) total += value;\n        System.out.println(total);",
    "The counter starts at the first included value, advances on every iteration, and handles n = 0 with an empty traversal.",
    [normal("5\n", "15"), boundary("0\n", "0")],
  ),
  "java.methods.contracts": javaTask(
    "Read value, minimum, and maximum integers. Implement and call a clamp method that returns the inclusive bounded result without mutation.",
    "    static int clamp(int value, int minimum, int maximum) {\n        return Math.max(minimum, Math.min(maximum, value));\n    }\n",
    "        int value = input.nextInt();\n        int minimum = input.nextInt();\n        int maximum = input.nextInt();\n        System.out.println(clamp(value, minimum, maximum));",
    "The static method has one typed purpose, returns its result, and has no hidden effect on caller state.",
    [normal("12 0 10\n", "10"), boundary("-3 -3 7\n", "-3")],
  ),
  "java.methods.overload-scope": javaTask(
    "Read an integer n. Call overloaded twice(int) and twice(double), then print both results with one decimal place for the double.",
    "    static int twice(int value) { return value * 2; }\n    static double twice(double value) { return value * 2.0; }\n",
    "        int n = input.nextInt();\n        System.out.printf(\"%d %.1f%n\", twice(n), twice(n + 0.5));",
    "Compile-time argument types select the two overloads; the local n remains distinct from each method parameter.",
    [normal("4\n", "8 9.0"), boundary("0\n", "0 1.0")],
  ),
  "java.data.arrays": javaTask(
    "Read row count, then for each row read its length and integer elements. Print each ragged row sum separated by one space.",
    "",
    "        int rows = input.nextInt();\n        int[][] values = new int[rows][];\n        for (int row = 0; row < rows; row++) {\n            int columns = input.nextInt();\n            values[row] = new int[columns];\n            for (int column = 0; column < columns; column++) values[row][column] = input.nextInt();\n        }\n        for (int row = 0; row < values.length; row++) {\n            int sum = 0;\n            for (int value : values[row]) sum += value;\n            if (row > 0) System.out.print(\" \" );\n            System.out.print(sum);\n        }\n        System.out.println();",
    "Each row is allocated and bounded independently, so empty and differently sized rows remain valid.",
    [normal("2 3 1 2 3 2 4 5\n", "6 9"), boundary("2 0 1 -2\n", "0 -2")],
  ),
  "java.data.strings": javaTask(
    "Read two complete lines. Print equal or different using String content equality, then print their combined Unicode code-point count.",
    "",
    "        String left = input.hasNextLine() ? input.nextLine() : \"\";\n        String right = input.hasNextLine() ? input.nextLine() : \"\";\n        System.out.println(left.equals(right) ? \"equal\" : \"different\");\n        System.out.println(left.codePointCount(0, left.length()) + right.codePointCount(0, right.length()));",
    "The task uses equals for content and codePointCount rather than reference identity or raw UTF-16 length.",
    [normal("java\njava\n", "equal\n8"), boundary("😀\nA\n", "different\n2")],
  ),
  "java.objects.class": javaTask(
    "Read a non-negative starting count and number of increments. Implement a Counter with private state and print the final value.",
    "    static final class Counter {\n        private int value;\n        Counter(int value) { if (value < 0) throw new IllegalArgumentException(); this.value = value; }\n        void increment() { value++; }\n        int value() { return value; }\n    }\n",
    "        Counter counter = new Counter(input.nextInt());\n        int increments = input.nextInt();\n        for (int i = 0; i < increments; i++) counter.increment();\n        System.out.println(counter.value());",
    "Private representation is changed only through cohesive methods that preserve the non-negative invariant.",
    [normal("3 4\n", "7"), boundary("0 0\n", "0")],
  ),
  "java.objects.constructors": javaTask(
    "Read low, high, and probe. Construct an inclusive Range that rejects low greater than high; print contains or invalid.",
    "    static final class Range {\n        private final int low; private final int high;\n        Range(int low, int high) { if (low > high) throw new IllegalArgumentException(); this.low = low; this.high = high; }\n        boolean contains(int value) { return value >= low && value <= high; }\n    }\n",
    "        int low = input.nextInt(), high = input.nextInt(), probe = input.nextInt();\n        try { System.out.println(new Range(low, high).contains(probe) ? \"contains\" : \"outside\"); }\n        catch (IllegalArgumentException error) { System.out.println(\"invalid\"); }",
    "The constructor establishes low <= high before a Range reference becomes usable.",
    [normal("2 5 5\n", "contains"), boundary("5 2 3\n", "invalid")],
  ),
  "java.objects.identity": javaTask(
    "Read two integer amounts. Construct two value objects and print whether equals is true and whether their hash codes agree.",
    "    static final class Amount {\n        private final int value; Amount(int value) { this.value = value; }\n        @Override public boolean equals(Object other) { return other instanceof Amount amount && value == amount.value; }\n        @Override public int hashCode() { return Integer.hashCode(value); }\n    }\n",
    "        Amount left = new Amount(input.nextInt());\n        Amount right = new Amount(input.nextInt());\n        System.out.println(left.equals(right) + \" \" + (left.hashCode() == right.hashCode()));",
    "The value object's equality and hashing use the same stable field, while two instances remain distinct identities.",
    [normal("7 7\n", "true true"), boundary("7 8\n", "false false")],
  ),
  "java.objects.records": javaTask(
    "Read point coordinates x and y. Use a Point record and print its Manhattan distance from the origin followed by x,y.",
    "    record Point(int x, int y) {\n        int manhattan() { return Math.abs(x) + Math.abs(y); }\n    }\n",
    "        Point point = new Point(input.nextInt(), input.nextInt());\n        System.out.println(point.manhattan());\n        System.out.println(point.x() + \",\" + point.y());",
    "The record transparently carries immutable component values while adding one cohesive derived operation.",
    [normal("3 -4\n", "7\n3,-4"), boundary("0 0\n", "0\n0,0")],
  ),
  "java.abstraction.interfaces": javaTask(
    "Read add or multiply followed by two integers. Select one Operation interface implementation and print its result.",
    "    interface Operation { int apply(int left, int right); }\n    static final class Add implements Operation { public int apply(int left, int right) { return left + right; } }\n    static final class Multiply implements Operation { public int apply(int left, int right) { return left * right; } }\n",
    "        String kind = input.next(); int left = input.nextInt(), right = input.nextInt();\n        Operation operation = kind.equals(\"add\") ? new Add() : new Multiply();\n        System.out.println(operation.apply(left, right));",
    "Two unrelated implementations honor the same focused behavioral contract and the caller depends only on that interface.",
    [normal("add 4 5\n", "9"), boundary("multiply 0 99\n", "0")],
  ),
  "java.abstraction.inheritance": javaTask(
    "Read square or rectangle and dimensions. Model both as Shape subtypes and print integer area through a Shape reference.",
    "    abstract static class Shape { abstract int area(); }\n    static final class Square extends Shape { private final int side; Square(int side) { this.side = side; } int area() { return side * side; } }\n    static final class Rectangle extends Shape { private final int width, height; Rectangle(int width, int height) { this.width = width; this.height = height; } int area() { return width * height; } }\n",
    "        String kind = input.next();\n        Shape shape = kind.equals(\"square\") ? new Square(input.nextInt()) : new Rectangle(input.nextInt(), input.nextInt());\n        System.out.println(shape.area());",
    "Each subtype satisfies the complete Shape area contract and initializes its own required representation.",
    [normal("rectangle 3 4\n", "12"), boundary("square 0\n", "0")],
  ),
  "java.abstraction.dispatch": javaTask(
    "Read dog or cat. Store the chosen subtype in an Animal reference and print the overridden sound selected at runtime.",
    "    static class Animal { String sound() { return \"unknown\"; } }\n    static final class Dog extends Animal { @Override String sound() { return \"woof\"; } }\n    static final class Cat extends Animal { @Override String sound() { return \"meow\"; } }\n",
    "        Animal animal = input.next().equals(\"dog\") ? new Dog() : new Cat();\n        System.out.println(animal.sound());",
    "The compile-time reference is Animal, but the overridden instance method is selected from the runtime receiver.",
    [normal("dog\n", "woof"), boundary("cat\n", "meow")],
  ),
  "java.abstraction.composition": javaTask(
    "Read whitespace-separated integers. Push them into a Stack that owns an ArrayDeque, then print values in LIFO order.",
    "    static final class Stack {\n        private final ArrayDeque<Integer> values = new ArrayDeque<>();\n        void push(int value) { values.push(value); }\n        boolean isEmpty() { return values.isEmpty(); }\n        int pop() { return values.pop(); }\n    }\n",
    "        Stack stack = new Stack();\n        while (input.hasNextInt()) stack.push(input.nextInt());\n        boolean first = true;\n        while (!stack.isEmpty()) { if (!first) System.out.print(\" \" ); System.out.print(stack.pop()); first = false; }\n        System.out.println();",
    "The purpose-built Stack exposes only LIFO behavior and delegates storage without inheriting unrelated deque operations.",
    [normal("1 2 3\n", "3 2 1"), boundary("9\n", "9")],
  ),
  "java.generics.types": javaTask(
    "Read whitespace-separated words. Store the first word in Box<String> and return it through the generic type without a cast.",
    "    static final class Box<T> { private final T value; Box(T value) { this.value = value; } T value() { return value; } }\n",
    "        Box<String> box = new Box<>(input.next());\n        System.out.println(box.value());",
    "The type parameter preserves the String relationship from construction to retrieval and avoids a raw type or cast.",
    [normal("alpha beta\n", "alpha"), boundary("x\n", "x")],
  ),
  "java.generics.bounds": javaTask(
    "Read integers until end of input. Pass List<Integer> to a sum method accepting List<? extends Number> and print the long sum.",
    "    static long sum(List<? extends Number> values) { long total = 0; for (Number value : values) total += value.longValue(); return total; }\n",
    "        List<Integer> values = new ArrayList<>();\n        while (input.hasNextInt()) values.add(input.nextInt());\n        System.out.println(sum(values));",
    "The wildcard marks the list as a Number producer, allowing List<Integer> without unsafe insertion.",
    [normal("1 2 3 4\n", "10"), boundary("\n", "0")],
  ),
  "java.collections.core": javaTask(
    "Read whitespace-separated words. Use a Map to count them and print key=count pairs in sorted-key order.",
    "",
    "        Map<String, Integer> counts = new TreeMap<>();\n        while (input.hasNext()) counts.merge(input.next(), 1, Integer::sum);\n        System.out.println(counts.entrySet().stream().map(entry -> entry.getKey() + \"=\" + entry.getValue()).collect(Collectors.joining(\" \")));",
    "A Map provides key lookup/counting and TreeMap adds the explicit sorted presentation guarantee.",
    [normal("pear apple pear\n", "apple=1 pear=2"), boundary("solo\n", "solo=1")],
  ),
  "java.collections.iteration": javaTask(
    "Read integers into a mutable list. Remove odd values safely through an Iterator and print the remaining even values.",
    "",
    "        List<Integer> values = new ArrayList<>();\n        while (input.hasNextInt()) values.add(input.nextInt());\n        for (Iterator<Integer> iterator = values.iterator(); iterator.hasNext();) if (iterator.next() % 2 != 0) iterator.remove();\n        System.out.println(values.stream().map(String::valueOf).collect(Collectors.joining(\" \")));",
    "Structural removal happens through the active iterator, preserving traversal validity.",
    [normal("1 2 3 4\n", "2 4"), boundary("1 3 5\n", "")],
  ),
  "java.functional.lambdas": javaTask(
    "Read whitespace-separated words. Sort them by length and then natural text using a Comparator lambda, and print the result.",
    "",
    "        List<String> words = new ArrayList<>(); while (input.hasNext()) words.add(input.next());\n        words.sort((left, right) -> { int byLength = Integer.compare(left.length(), right.length()); return byLength != 0 ? byLength : left.compareTo(right); });\n        System.out.println(String.join(\" \" , words));",
    "The lambda implements one Comparator contract and captures no mutable external accumulator.",
    [normal("pear a fig kiwi\n", "a fig kiwi pear"), boundary("bb aa\n", "aa bb")],
  ),
  "java.functional.streams": javaTask(
    "Read integers and use one stream pipeline to filter even values, square them, and print their sum.",
    "",
    "        List<Integer> values = new ArrayList<>(); while (input.hasNextInt()) values.add(input.nextInt());\n        long total = values.stream().filter(value -> value % 2 == 0).mapToLong(value -> (long) value * value).sum();\n        System.out.println(total);",
    "The finite source flows through lazy filter/map stages into one terminal sum without stream reuse.",
    [normal("1 2 3 4\n", "20"), boundary("1 3\n", "0")],
  ),
  "java.functional.collectors": javaTask(
    "Read words and collect counts grouped by first character. Print character=count pairs in sorted-key order.",
    "",
    "        List<String> words = new ArrayList<>(); while (input.hasNext()) words.add(input.next());\n        Map<Character, Long> counts = words.stream().collect(Collectors.groupingBy(word -> word.charAt(0), TreeMap::new, Collectors.counting()));\n        System.out.println(counts.entrySet().stream().map(entry -> entry.getKey() + \"=\" + entry.getValue()).collect(Collectors.joining(\" \")));",
    "groupingBy supplies an explicit TreeMap result and counting collector, so duplicate groups combine deterministically.",
    [normal("ant apple bee\n", "a=2 b=1"), boundary("z\n", "z=1")],
  ),
  "java.functional.optional": javaTask(
    "Read one token. Parse it as an integer into Optional when valid; print twice the value or missing when invalid.",
    "    static Optional<Integer> parse(String text) { try { return Optional.of(Integer.parseInt(text)); } catch (NumberFormatException error) { return Optional.empty(); } }\n",
    "        String token = input.hasNext() ? input.next() : \"\";\n        System.out.println(parse(token).map(value -> value * 2).map(String::valueOf).orElse(\"missing\"));",
    "Optional makes return-value absence explicit and mapping avoids an unsafe get call.",
    [normal("21\n", "42"), boundary("not-a-number\n", "missing")],
  ),
} as const satisfies Readonly<Record<string, JavaPythonCodeTask>>;

const PYTHON_TASKS = {
  "python.values.scalars": pythonTask(
    "Read one token. Print missing when it is exactly none; otherwise parse an integer and print int:<value>, preserving zero as a valid value.",
    "    token = data.strip()\n    value = None if token == \"none\" else int(token)\n    return \"missing\" if value is None else f\"int:{value}\"",
    "The solution uses None as the explicit absence singleton and does not confuse the falsey integer zero with absence.",
    [normal("7\n", "int:7"), boundary("none\n", "missing")],
  ),
  "python.values.expressions": pythonTask(
    "Read integers a and b where b is positive. Print a // b and the result of the chained comparison 0 <= a < b as lowercase true or false.",
    "    a, b = map(int, data.split())\n    return f\"{a // b} {str(0 <= a < b).lower()}\"",
    "The solution applies floor division and one chained comparison whose middle operand is evaluated once.",
    [normal("3 5\n", "0 true"), boundary("5 5\n", "1 false")],
  ),
  "python.control.selection": pythonTask(
    "Read a score and return invalid, fail, pass, or distinction using valid range 0..100 and boundaries 50 and 80.",
    "    score = int(data.strip())\n    if not 0 <= score <= 100:\n        return \"invalid\"\n    if score < 50:\n        return \"fail\"\n    if score < 80:\n        return \"pass\"\n    return \"distinction\"",
    "Ordered conditions cover invalid input and every valid boundary exactly once.",
    [normal("50\n", "pass"), boundary("101\n", "invalid")],
  ),
  "python.control.iteration": pythonTask(
    "Read a non-negative integer n and use iteration to return the sum of 1 through n.",
    "    n = int(data.strip())\n    total = 0\n    for value in range(1, n + 1):\n        total += value\n    return str(total)",
    "range excludes its stop, so n + 1 includes n and n = 0 produces an empty traversal.",
    [normal("5\n", "15"), boundary("0\n", "0")],
  ),
  "python.collections.list-tuple": pythonTask(
    "Read one or more integers. Print the reversed list, then print a tuple-style first,last pair.",
    "    values = [int(token) for token in data.split()]\n    reversed_values = values[::-1]\n    endpoints = (values[0], values[-1])\n    return f\"{' '.join(map(str, reversed_values))}\\n{endpoints[0]},{endpoints[1]}\"",
    "Slicing creates a reversed shallow list result while the tuple models the fixed endpoint pair.",
    [normal("1 2 3\n", "3 2 1\n1,3"), boundary("9\n", "9\n9,9")],
  ),
  "python.collections.dict-set": pythonTask(
    "Read words. Count them with a dictionary and print sorted key=count pairs, followed by the sorted unique words.",
    "    words = data.split()\n    counts: dict[str, int] = {}\n    for word in words:\n        counts[word] = counts.get(word, 0) + 1\n    count_line = ' '.join(f\"{word}={counts[word]}\" for word in sorted(counts))\n    unique_line = ' '.join(sorted(set(words)))\n    return f\"{count_line}\\n{unique_line}\"",
    "The dictionary provides keyed counting, the set provides uniqueness, and sorting is requested explicitly for deterministic presentation.",
    [normal("pear apple pear\n", "apple=1 pear=2\napple pear"), boundary("solo\n", "solo=1\nsolo")],
  ),
  "python.collections.aliasing": pythonTask(
    "Read an integer n. Make a nested list and a shallow outer copy, append n through the copy's first inner list, and print the shared inner value plus whether outer identities differ.",
    "    n = int(data.strip())\n    original = [[0], [1]]\n    copied = original.copy()\n    copied[0].append(n)\n    return f\"{original[0][-1]} {str(original is not copied).lower()} {str(original[0] is copied[0]).lower()}\"",
    "The outer list is distinct after a shallow copy, but both outer containers still reference the same nested lists.",
    [normal("7\n", "7 true true"), boundary("0\n", "0 true true")],
  ),
  "python.collections.text": pythonTask(
    "Read one line of Unicode text. Normalize runs of whitespace with split/join, then print the normalized text and its code-point length.",
    "    normalized = ' '.join(data.strip().split())\n    return f\"{normalized}\\n{len(normalized)}\"",
    "Python str operations treat the input as Unicode text, and encoding is intentionally absent from this in-memory boundary.",
    [normal("  hello   world  \n", "hello world\n11"), boundary("A  B\n", "A B\n3")],
  ),
  "python.functions.contracts": pythonTask(
    "Read value, minimum, and maximum integers. Implement a clamp function with a clear returned result and print it.",
    "    def clamp(value: int, minimum: int, maximum: int) -> int:\n        \"\"\"Return value limited to the inclusive bounds.\"\"\"\n        return max(minimum, min(maximum, value))\n\n    value, minimum, maximum = map(int, data.split())\n    return str(clamp(value, minimum, maximum))",
    "The function has one documented input/output contract, no hidden mutation, and explicit boundary behavior.",
    [normal("12 0 10\n", "10"), boundary("-3 -3 7\n", "-3")],
  ),
  "python.functions.parameters": pythonTask(
    "Read two integers. Call a function twice that appends to a per-call optional list and print each returned list separated by a vertical bar.",
    "    def collected(value: int, items: list[int] | None = None) -> list[int]:\n        if items is None:\n            items = []\n        items.append(value)\n        return items\n\n    left, right = map(int, data.split())\n    return f\"{collected(left)}|{collected(right)}\"",
    "None is an immutable sentinel and each call creates its own list instead of sharing a definition-time mutable default.",
    [normal("1 2\n", "[1]|[2]"), boundary("0 0\n", "[0]|[0]")],
  ),
  "python.functions.scope-closures": pythonTask(
    "Read starting value and step count. Build a closure counter using nonlocal and print each successive value.",
    "    start, steps = map(int, data.split())\n    def make_counter(initial: int):\n        current = initial\n        def advance() -> int:\n            nonlocal current\n            current += 1\n            return current\n        return advance\n\n    counter = make_counter(start)\n    return ' '.join(str(counter()) for _ in range(steps))",
    "The closure retains one enclosing cell and nonlocal makes the intended rebinding explicit.",
    [normal("3 4\n", "4 5 6 7"), boundary("9 0\n", "")],
  ),
  "python.functions.recursion": pythonTask(
    "Read a non-negative integer n. Implement recursive factorial with an explicit base case and print the result.",
    "    n = int(data.strip())\n    def factorial(value: int) -> int:\n        if value == 0:\n            return 1\n        return value * factorial(value - 1)\n    return str(factorial(n))",
    "Every recursive call decreases the non-negative integer toward the zero base case.",
    [normal("5\n", "120"), boundary("0\n", "1")],
  ),
  "python.objects.class": pythonTask(
    "Read a non-negative start and an increment count. Use a Counter class with per-instance state and print the final value.",
    "    class Counter:\n        def __init__(self, value: int) -> None:\n            if value < 0:\n                raise ValueError('negative start')\n            self._value = value\n        def increment(self) -> None:\n            self._value += 1\n        @property\n        def value(self) -> int:\n            return self._value\n\n    start, increments = map(int, data.split())\n    counter = Counter(start)\n    for _ in range(increments):\n        counter.increment()\n    return str(counter.value)",
    "The mutable count belongs to each instance and changes only through the class's focused behavior.",
    [normal("3 4\n", "7"), boundary("0 0\n", "0")],
  ),
  "python.objects.dataclass": pythonTask(
    "Read point coordinates x and y. Model the point as a frozen data class and print Manhattan distance followed by its generated representation.",
    "    x, y = map(int, data.split())\n    point = Point(x, y)\n    return f\"{abs(point.x) + abs(point.y)}\\n{point!r}\"",
    "The frozen data class provides transparent fields, generated representation, and field-based value behavior.",
    [normal("3 -4\n", "7\nPoint(x=3, y=-4)"), boundary("0 0\n", "0\nPoint(x=0, y=0)")],
    "from dataclasses import dataclass\n\n@dataclass(frozen=True)\nclass Point:\n    x: int\n    y: int\n",
  ),
  "python.objects.inheritance": pythonTask(
    "Read square or rectangle and dimensions. Use substitutable Shape subclasses with cooperative initialization and print area.",
    "    tokens = data.split()\n    if tokens[0] == 'square':\n        shape: Shape = Square(int(tokens[1]))\n    else:\n        shape = Rectangle(int(tokens[1]), int(tokens[2]))\n    return str(shape.area())",
    "Both subtypes initialize base state with super and honor the complete area contract through one Shape reference.",
    [normal("rectangle 3 4\n", "12"), boundary("square 0\n", "0")],
    "\nclass Shape:\n    def __init__(self, name: str) -> None:\n        self.name = name\n    def area(self) -> int:\n        raise NotImplementedError\n\nclass Square(Shape):\n    def __init__(self, side: int) -> None:\n        super().__init__('square')\n        self.side = side\n    def area(self) -> int:\n        return self.side * self.side\n\nclass Rectangle(Shape):\n    def __init__(self, width: int, height: int) -> None:\n        super().__init__('rectangle')\n        self.width = width\n        self.height = height\n    def area(self) -> int:\n        return self.width * self.height\n",
  ),
  "python.objects.protocols": pythonTask(
    "Read integers into a Bag that implements repr, len, and iteration. Print its representation, length, and sum.",
    "    bag = Bag(int(token) for token in data.split())\n    return f\"{bag!r}\\n{len(bag)} {sum(bag)}\"",
    "The object participates predictably in representation, sized-container, and iterable protocols without side effects.",
    [normal("1 2 3\n", "Bag([1, 2, 3])\n3 6"), boundary("\n", "Bag([])\n0 0")],
    "\nclass Bag:\n    def __init__(self, values) -> None:\n        self._values = list(values)\n    def __repr__(self) -> str:\n        return f\"Bag({self._values!r})\"\n    def __len__(self) -> int:\n        return len(self._values)\n    def __iter__(self):\n        return iter(self._values)\n",
  ),
  "python.iteration.comprehensions": pythonTask(
    "Read integers and use one readable comprehension to print the squares of only the even values.",
    "    values = [int(token) for token in data.split()]\n    squares = [value * value for value in values if value % 2 == 0]\n    return ' '.join(map(str, squares))",
    "The list comprehension is a bounded transformation with one expression and one readable filter.",
    [normal("1 2 3 4\n", "4 16"), boundary("1 3\n", "")],
  ),
  "python.iteration.iterator": pythonTask(
    "Read a non-negative n. Implement a Countdown iterable that returns a fresh iterator and print n down to 1.",
    "    countdown = Countdown(int(data.strip()))\n    first = ' '.join(map(str, countdown))\n    second = ' '.join(map(str, countdown))\n    return f\"{first}\\n{second}\"",
    "Each call to iter creates independent one-pass state, so the reusable iterable supports two identical traversals.",
    [normal("3\n", "3 2 1\n3 2 1"), boundary("0\n", "\n")],
    "\nclass Countdown:\n    def __init__(self, start: int) -> None:\n        self.start = start\n    def __iter__(self):\n        return iter(range(self.start, 0, -1))\n",
  ),
  "python.iteration.generator": pythonTask(
    "Read a positive chunk size followed by words. Use a generator to emit lazy chunks and print chunks joined with vertical bars.",
    "    tokens = data.split()\n    size = int(tokens[0])\n    words = tokens[1:]\n    def chunks(values: list[str], width: int):\n        for index in range(0, len(values), width):\n            yield values[index:index + width]\n    return '|'.join(','.join(chunk) for chunk in chunks(words, size))",
    "The generator yields one bounded slice at a time and naturally handles a final partial chunk.",
    [normal("2 a b c d e\n", "a,b|c,d|e"), boundary("3 one\n", "one")],
  ),
  "python.iteration.decorator": pythonTask(
    "Read factor and value. Decorate a multiply function with a metadata-preserving wrapper and print function-name=result.",
    "    factor, value = map(int, data.split())\n    @preserve_call\n    def multiply(number: int) -> int:\n        return factor * number\n    return f\"{multiply.__name__}={multiply(value)}\"",
    "The wrapper forwards arguments and results explicitly, while functools.wraps preserves the original function name.",
    [normal("3 7\n", "multiply=21"), boundary("0 99\n", "multiply=0")],
    "from functools import wraps\n\ndef preserve_call(function):\n    @wraps(function)\n    def wrapper(*args, **kwargs):\n        return function(*args, **kwargs)\n    return wrapper\n",
  ),
} as const satisfies Readonly<Record<string, JavaPythonCodeTask>>;

/** Runnable, skill-specific tasks are present only for declared core language skills. */
export const JAVA_PYTHON_CODE_TASKS = {
  ...JAVA_TASKS,
  ...PYTHON_TASKS,
} as const satisfies Readonly<Record<string, JavaPythonCodeTask>>;
