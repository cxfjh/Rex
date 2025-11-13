## Rex 快速开始

### 1. 引入库

直接在HTML中引入Rex.js，无需任何构建步骤：

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Rex.js 快速开始</title>
    <!-- 在顶部引入，二选一即可 -->
    <script src="https://cxfjh.cn/js/rex/0.0.1.js"></script>        <!-- 完整版本 -->
    <script src="https://cxfjh.cn/js/rex/min.0.0.1.js"></script>    <!-- 压缩min版本 -->
</head>
<body>
</body>
</html>
```

### 2. 基础示例

```html

<body>
    <!-- 响应式计数示例，{{ }} 执行表达式语句时需要加上 .value -->
    <h1>{{ count }} {{ count.value + 2 }}</h1>
	
    <!-- 事件绑定示例，里面执行的是 JavaScript 代码，需要加 .value -->
    <button r-click="count.value++">增加</button>
    <button r-click="count.value--">减少</button>
	
    <!-- 双向绑定 -->
    <input type="text" r-model="name" placeholder="输入名字">
    <p>你好，{{ name }}!</p>
	
    <script>
        // 定义响应式数据
        const count = ref(0);
        const name = ref("");
		
        // r-model 双向绑定需要provide注册
        provide({ name });
    </script>
</body>
</html>
```

## 核心功能文档

### 1. 响应式系统

#### ref - 基础类型响应式

```javascript
// 定义基础类型响应式数据
const count = ref(0);
const name = ref("张三");

// 访问/修改值（注意需要 .value）
console.log(count.value); // 0
count.value++; // 修改值，页面自动更新
```

#### reactive - 对象/数组响应式

```javascript
// 定义对象响应式数据
const user = reactive({
    name: "李四",
    age: 20
});

// 直接修改，无需 .value
user.age = 21; // 页面自动更新

// 数组响应式
const list = reactive([1, 2, 3]);
list.push(4); // 支持数组方法
```

#### provide - 双向绑定注册

```javascript
// 用于r-model双向绑定的变量需要provide注册
const name = ref("");
const age = ref(0);

provide({ name, age }); // 注册
```

### 2. 模板指令

| 指令        | 作用    | 示例                                            |
|-----------|-------|-----------------------------------------------|
| `r-if`    | 条件渲染  | `<div r-if="count.value > 5">显示</div>`        |
| `r-click` | 点击事件  | `<button r-click="count.value++">增加</button>` |
| `r-model` | 双向绑定  | `<input type="text" r-model="name">`          |
| `r-for`   | 循环渲染  | `<div r-for="count">第{{ index }}项</div>`      |
| `r-arr`   | 数组循环  | `<div r-arr="list">值：{{ value }}</div>`       |
| `r-api`   | 接口请求  | `<div r-api="https://api.com/data">...</div>` |
| `r-cp`    | 组件使用  | `<div r-cp="user" $name="张三"></div>`          |
| `r-route` | 路由跳转  | `<button r-route="home">首页</button>`          |
| `r-dom`   | 组件引用  | `<div r-dom="user"></div>`                  |
| `r`       | DOM引用 | `<div r="container">容器</div>`                 |

#### 指令详细示例

##### r-if 条件渲染
```html
<!-- 支持表达式，表达式需要加 .value -->
<div r-if="count.value % 2 === 0">偶数</div>
<div r-if="user.age > 18">成年</div>
```

##### r-for 循环渲染
```html
<!-- 循环count次，索引从1开始，索引默认是 index  -->
<div r-for="count">
    <p>第{{ index }}项</p>
</div>

<!-- 自定义索引名-->
<div r-for="5" index="i">
    <p>{{ i }}</p>
</div>
```

##### r-arr 数组循环
```html
<!-- 循环list数组，内容值默认是 value，索引默认是 index  -->
<div r-arr="list" index="idx">
    索引：{{ idx }} - 值：{{ value.name }}
</div>

<!-- 自定义值变量名-->
<div r-arr="users" value="user">
    {{ user.name }} - {{ user.age }}
</div>
```

##### r-api 接口请求
```html
<!-- 基础用法 -->
<div r-api="https://api.com/data" list="result">
    {{ value.title }}
</div>

<!-- 带参数配置 -->
<div
    r-api="https://api.com/data"         // 请求地址
    meth="POST"                          // 请求方法，默认GET
    hdr='{"Authorization": "token"}'     // 请求头
    list="data"                          // 获取请求结果的data数据
    refr="#refreshBtn"                   // 刷新按钮
    arr="data"                           // 表示需要手动渲染数据，data为数组变量
    aw                                   // 表示手动请求，返回一个_aw变量布尔值，true表示请求完成, false表示请求未完成
>
    <button r-click="fetchAndRender()">加载数据</button>
    <div r-if="_aw" r-arr="data">{{ value.content }}</div>
</div>

<button id="refreshBtn">刷新</button>
```

##### r-click 事件指令

###### 基础用法：点击事件
```html
<!-- 单个表达式 -->
<button r-click="count.value++">增加计数</button>
<button r-click="count.value = 0">重置计数</button>

<!-- 多语句执行（用分号分隔） -->
<button r-click="count.value++; alert('当前计数：' + count.value)">增加并弹窗</button>

<!-- 调用函数 -->
<button r-click="handleSubmit()">提交</button>

<script>
const count = ref(0);

// 定义全局函数
function handleSubmit() {
  console.log("提交数据", count.value);
  alert("提交成功！");
}
</script>
```

###### 扩展事件类型（非click事件）
通过元素属性指定事件类型，支持所有原生事件：
```html
<!-- 双击事件 -->
<div r-click="alert('双击触发')" dblclick>双击我</div>

<!-- 鼠标悬停事件 -->
<div r-click="console.log('鼠标移入')" mouseover>鼠标移入</div>

<!-- 键盘事件 -->
<input 
  type="text" 
  r-click="console.log('按下了：' + event.key)" 
  keydown 
  placeholder="按下键盘触发"
>
```

###### 键盘事件按键过滤
支持按特定按键触发事件，内置常用按键别名（Enter、Esc等）：
```html
<!-- 只在按下Enter键时触发 -->
<input 
  type="text" 
  r-click="handleSearch()"
  keydown="enter"  <!-- 按键过滤：仅Enter触发 -->
  placeholder="按Enter搜索"
>

<!-- 只在按下Esc键时触发 -->
<input 
  type="text" 
  r-click="this.value = ''"
  keydown="esc"  <!-- 按键过滤：仅Esc触发 -->
  placeholder="按Esc清空"
>

<!-- 支持原生按键名 -->
<input 
  type="text" 
  r-click="console.log('按下了空格')"
  keydown=" "  <!-- 空格按键 -->
>
```

##### r-cp 组件指令

```html
<!-- 使用 template 标签定义名为"user-card"的组件 -->
<template r-cp="user-card">
    <div class="card">
        {{ name }}
    </div>
</template>

<!-- 使用组件，使用$来传递数据 -->
<div r-cp="user-card" $name="张三"></div>
```

### 3. 组件系统

#### 定义组件
使用`dom()`函数定义组件，支持模板、样式、脚本分离：

```javascript
// 定义组件
const UserComponent = dom("user", {
  // 模板
  template: `
    <div class="user-card">
      <h3>{{ username }}</h3>
      <p>年龄：{{ age.value }}</p>
      <button r-click="increaseAge()">增加年龄</button>
    </div>
  `,
  
  // 样式（支持作用域隔离）
  style: `
    .user-card {
      border: 1px solid #ccc;
      padding: 16px;
      border-radius: 8px;
    }
    button {
      background: #42b983;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
    }
  `,
  
  // 脚本逻辑
  script: ({ $props }, { ref }) => {
    // 初始化数据
    const setup = () => {
      const age = ref($props.initAge || 20);
      const username = ref("匿名用户");
      
      // 方法
      const increaseAge = () => {
        age.value++;
      };
      
      return { age, username, increaseAge };
    };
    
    // 生命周期钩子
    function mounted() {
      console.log("组件 DOM 挂载完成");
    };
    
    function unmounted() {
       console.log(`组件 DOM 销毁时调用`);
    }
    
    return { setup, mounted, unmounted };
  },
  
  // 样式隔离（默认启用）手动 UserComponent({ initAge: 18 }, "#app", true);
  styleIsolation: true
    
  // 自动挂载到指定元素，手动 UserComponent({ initAge: 18 }, "#app");
  // mountTo: "#app",
});

// 挂载组件
UserComponent({ initAge: 18 }, "#user", true);
```

#### r-dom 使用组件
```html
<!-- 定义挂载容器，需要挂载 -->
<div id="user"></div>

<!-- 或通过 r-dom="组件名" 指令使用，无需通过 UserComponent 挂载组件 -->
<div r-dom="user" $initAge="22"></div>
```

### 4. 路由系统

#### 定义路由页面
```html
<!-- 定义路由页面 -->
<div r-page="home">
  <h1>首页</h1>
  <p>{{ welcomeText }}</p>
</div>

<div r-page="about">
  <h1>关于我们</h1>
</div>

<!-- 路由容器 -->
<div id="view"></div>

<!-- 路由导航 -->
<button r-route="home">首页</button>
<button r-route="about">关于</button>
```

#### 编程式导航
```javascript
// 跳转路由
router.nav("home");
```

### 5. DOM引用

使用`r`指令获取DOM元素：
```html
<!-- 定义引用 -->
<body>
    <div r="container">内容容器</div>
    <input type="text" r="usernameInput">
</body>

<!-- 初始阶段不能立即访问 -->
<script>
  // 在初始化访问引用
  onMounted(() => {
    console.log($r.container); // 获取DOM元素
    $r.usernameInput.value = "默认值";
  });
</script>

<!-- 给标签加一个src，功能和onMounted一样 -->
<script src>
    console.log($r.container); // 获取DOM元素
    $r.usernameInput.value = "默认值";
</script>
```

## 注意事项

1. **响应式访问**：
    - `ref`类型数据在脚本中需要通过`.value`访问/修改
    - 模板中使用时无需`.value`（指令内部已处理）

2. **r-model绑定**：
    - 必须通过`provide`注册后才能使用
    - 支持input/select/checkbox/radio等表单元素

3. **组件样式隔离**：
    - 默认启用样式隔离，组件样式不会影响全局
    - 可通过`styleIsolation: false`关闭隔离

4. **表达式解析**：
    - 模板中的`{{ }}`支持JS表达式
    - 指令中的值（如r-if/r-click）直接执行JS代码

5. **组件使用顺序**：
    - 组件必须先通过`dom()`函数定义，再通过`r-cp`指令使用
    - 传递给组件的响应式数据，组件内部修改不会影响外部（单向数据流）
