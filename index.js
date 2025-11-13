const _nodeContentMap = new WeakMap();              // 存储文本节点的原始内容
const _depsMap = new WeakMap();                     // 存储响应式对象的依赖关系
const _activeFns = [];                                              // 当前活跃的更新函数栈
const _directives = new Map();                              // 指令处理器注册表
const _elUpdateFns = new WeakMap();                 // 元素更新函数映射
const _elDeps = new WeakMap();                      // 元素依赖映射
const _INTERPOLATION_REGEX = /\{\{([^}]+?)}}/g;                   // 匹配插值表达式
const _VARIABLE_REGEX = /[a-zA-Z_$][\w$]*(?:\.[\w$]+)*/g;         // 匹配变量路径
const _pendingProviders = [];                                       // 存储待处理的作用域提供者
const _componentTemplates = new Map();                      // 组件模板缓存
const _componentInstances = new WeakMap();          // 组件实例缓存
const _mountedCallbacks = [];                                       // 存储 onMounted 回调函数
const _inlineScripts = [];                                          // 存储空src的script标签内的代码


// 事件类型映射
const EVENT_MAP = {
    click: "click", dblclick: "dblclick", mousedown: "mousedown", mouseup: "mouseup",
    mouseover: "mouseover", mouseout: "mouseout", mousemove: "mousemove",
    keydown: "keydown", keyup: "keyup", keypress: "keypress",
    focus: "focus", blur: "blur", input: "input", change: "change", submit: "submit",
    contextmenu: "contextmenu", scroll: "scroll", resize: "resize"
};
const KEY_MAP = {
    enter: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: " ",
    backspace: "Backspace", delete: "Delete", up: "ArrowUp", down: "ArrowDown",
    left: "ArrowLeft", right: "ArrowRight", ctrl: "Control", shift: "Shift",
    alt: "Alt", meta: "Meta"
};


/**
 * 批量更新管理器
 * 作用：收集更新函数并批量执行，减少重复渲染
 * 核心设计：利用队列缓冲更新操作，在下一帧统一执行，避免短时间内多次更新DOM
 */
const _BatchUpdater = {
    _queue: new Set(),    // 更新函数队列
    _isUpdating: false,   // 是否正在执行更新
    
    /**
     * 添加更新函数到队列
     * @param {Function} fn - 需要执行的更新函数
     * @returns {void}
     */
    add(fn) {
        if (typeof fn !== "function") return; // 严格类型校验，避免无效函数入队
        this._queue.add(fn); // 入队
        if (!this._isUpdating) this._scheduleUpdate(); // 调度执行
    },
    
    /**
     * 调度更新执行
     * 原理：requestAnimationFrame 确保更新在浏览器下一帧统一执行，减少DOM操作冲突
     */
    _scheduleUpdate() {
        this._isUpdating = true;
        requestAnimationFrame(() => this._executeQueue()); // 下一帧执行
    },
    
    /**
     * 执行队列中的所有更新函数
     * 核心：副本执行 + 提前清空队列 + 错误隔离
     */
    _executeQueue() {
        // 创建队列副本：避免执行过程中新增函数干扰当前批次
        const queueCopy = new Set(this._queue);
        this._queue.clear(); // 提前清空原队列：允许接收新地更新函数，避免后续更新阻塞（无等待）
        
        // 遍历执行：错误隔离 + 兼容 WeakSet 自动回收
        queueCopy.forEach((fn) => {
            try {
                fn.call(null);
            } catch (e) {
                console.error("[_BatchUpdater] 更新执行失败：", e, "关联函数：", fn);
            }
        });
        
        // 标记执行结束：允许新地更新批次触发
        this._isUpdating = false;
    }
};


/**
 * 依赖管理类
 * 作用：管理响应式数据的依赖关系
 * 核心：维护订阅者集合，当数据变化时通知相关订阅者更新
 */
class _Dependency {
    constructor() {
        this.subscribers = new Set();
        this.varSubs = new Map();
    }
    
    /**
     * 添加订阅者
     */
    subscribe(fn, variable = null) {
        if (typeof fn !== "function") return;
        this.subscribers.add(fn);
        if (variable) {
            if (!this.varSubs.has(variable)) this.varSubs.set(variable, new Set());
            this.varSubs.get(variable).add(fn);
        }
    }
    
    /**
     * 通知订阅者
     */
    notify(variable = null) {
        const targets = variable && this.varSubs.has(variable) ? this.varSubs.get(variable) : this.subscribers;
        if (targets.size === 0) return; // 快速返回空集合
        for (const fn of targets) _BatchUpdater.add(fn); // 使用迭代器直接遍历
    }
}


/**
 * 表达式解析工具
 * 作用：解析模板中的表达式，并收集依赖变量
 */
const _ExpressionParser = {
    _globals: new Set(["window", "document", "console", "alert"]),  // 全局变量白名单
    
    /**
     * 解析表达式
     * @param {string} expr - 要解析的表达式
     * @param {Object} scope - 作用域对象
     * @param {Set} deps - 依赖收集器
     * @returns {*} 解析结果
     * 核心：安全执行表达式并提取依赖变量，用于后续关联响应式数据
     */
    parse(expr, scope = {}, deps = new Set()) {
        if (typeof expr !== "string") return expr;
        
        try {
            // 收集表达式中的变量依赖
            const vars = expr.match(_VARIABLE_REGEX) || [];
            vars.forEach(v => {
                const rootVar = v.split(".")[0];  // 取根变量
                if (rootVar && !this._globals.has(rootVar) && !deps.has(rootVar)) deps.add(rootVar);  // 加入依赖集合
            });
            
            // 处理插值表达式语法
            if (expr.startsWith("{{") && expr.endsWith("}}")) expr = expr.slice(2, -2).trim();
            
            // 准备执行环境
            const keys = Object.keys(scope);
            const values = keys.map(k => scope[k]);
            
            // 使用Function构造函数安全执行表达式
            const evaluator = new Function(...keys, `return ${expr};`);
            const result = evaluator(...values);
            
            // 如果结果是ref，自动解包
            return result?.__isRef ? result.value : result;
        } catch (e) {
            console.warn("[_ExpressionParser] 解析错误:", expr, e);
            return expr;  // 解析失败时返回原始表达式
        }
    },
    
    /**
     * 解析文本中的插值表达式
     * @param {string} text - 包含插值的文本
     * @param {Object} scope - 作用域对象
     * @param {Set} deps - 依赖收集器
     * @returns {string} 解析后的文本
     * 逻辑：替换文本中所有{{}}插值为解析后的值
     */
    parseText(text, scope = {}, deps = new Set()) {
        if (typeof text !== "string") return text;
        return text.replace(_INTERPOLATION_REGEX, (_, expr) => this.parse(expr.trim(), scope, deps)); // 解析每个插值表达式
    }
};


/**
 * 创建元素更新函数
 * @param {HTMLElement} el - DOM元素
 * @param {Object} scope - 作用域对象
 * @returns {Function} 更新函数
 * 设计：为每个元素生成专属更新函数，包含其所有指令和属性的更新逻辑
 */
const _createUpdateFn = (el, scope = {}) => {
    // 强制更新标记（应对动态指令/属性场景）
    if (_elUpdateFns.has(el)) {
        const cachedFn = _elUpdateFns.get(el);
        if (!el["__forceUpdate"]) return cachedFn; // 若元素未标记"强制更新"，直接复用缓存函数
        el.__forceUpdate = false; // 标记清除：强制更新后重置，避免后续重复触发
    }
    
    // 依赖集合复用：避免每次创建函数都新建Set
    let deps = _elDeps.get(el);
    if (!deps) {
        deps = new Set();
        _elDeps.set(el, deps);
    }
    
    // 预收集元素属性：一次遍历区分"指令属性"和"普通插值属性"
    const attrMap = {
        directives: [],  // 存储指令属性
        interpolations: []  // 存储含插值的普通属性
    };
    
    // 仅在函数创建时遍历一次属性
    if (el.attributes) {
        for (let i = 0; i < el.attributes.length; i++) {
            const attr = el.attributes[i];
            const attrName = attr.name;
            const attrValue = attr.value;
            
            if (_directives.has(attrName)) attrMap.directives.push({ name: attrName, value: attrValue }); // 指令属性：直接加入指令列表
            else if (_INTERPOLATION_REGEX.test(attrValue)) attrMap.interpolations.push({ name: attrName, value: attrValue }); // 普通插值属性：仅含{{}}的属性才加入列表
        }
    }
    
    // 复用attrMap，减少DOM操作和重复判断
    const updateFn = () => {
        // 清空旧依赖：准备重新收集当前更新的依赖
        deps.clear();
        
        // 处理指令属性：直接复用attrMap中的指令列表
        for (let i = 0; i < attrMap.directives.length; i++) {
            const { name: dirName, value: dirValue } = attrMap.directives[i];
            const directiveHandler = _directives.get(dirName);
            
            // 防御性调用：避免指令处理器异常导致后续更新中断
            try {
                directiveHandler(el, dirValue, scope, deps);
            } catch (e) {
                console.error(`[createUpdateFn] 指令 "${dirName}" 执行错误:`, e);
            }
        }
        
        // 处理普通插值属性：复用attrMap，减少DOM读取
        for (let i = 0; i < attrMap.interpolations.length; i++) {
            const { name: attrName, value: attrValue } = attrMap.interpolations[i];
            // 解析插值并更新属性：仅当解析结果变化时才执行setAttribute
            const parsedValue = _ExpressionParser.parseText(attrValue, scope, deps);
            if (el.getAttribute(attrName) !== parsedValue) el.setAttribute(attrName, parsedValue);
        }
    };
    
    // 缓存更新函数：同时存储attrMap
    updateFn.__attrMap = attrMap;  // 挂载attrMap到函数上，便于后续查看属性分类
    _elUpdateFns.set(el, updateFn);
    
    // 元素销毁清理：绑定beforeunload事件，释放缓存
    const cleanup = () => {
        _elUpdateFns.delete(el);
        _elDeps.delete(el);
        el.removeEventListener("beforeunload", cleanup);
    };
    
    // 避免重复绑定清理事件
    if (!el["__updateCleanupBound"]) {
        el.addEventListener("beforeunload", cleanup);
        el.__updateCleanupBound = true;
    }
    
    return updateFn;
};


/**
 * 处理文本节点
 * @param {Text} node - 文本节点
 * @param {Object} scope - 作用域对象
 * 逻辑：为文本节点生成更新函数，实现插值内容的响应式更新
 */
const _processTextNode = (node, scope) => {
    // 缓存原始文本内容
    if (!_nodeContentMap.has(node)) _nodeContentMap.set(node, node.textContent);
    
    // 更新函数：解析插值并更新文本内容
    const update = () => {
        const original = _nodeContentMap.get(node);
        node.textContent = _ExpressionParser.parseText(original, scope);
    };
    
    // 首次执行并收集依赖：通过活跃函数栈记录当前更新函数，在解析表达式时关联依赖
    _activeFns.push(update);
    try {
        update(); // 执行时会触发数据的getter，从而收集依赖
    } finally {
        _activeFns.pop(); // 退出时移除当前更新函数
    }
    
    // 关联依赖：将文本节点的更新函数订阅到其依赖的变量
    const deps = new Set();
    _ExpressionParser.parseText(_nodeContentMap.get(node), scope, deps);
    deps.forEach(v => _depsMap.get(scope)?.subscribe(update, v));
};


/**
 * 处理DOM元素
 * @param {HTMLElement} el - DOM元素
 * @param {Object} scope - 作用域对象
 * 逻辑：初始化元素的更新函数，处理子文本节点和子元素，实现全量响应式关联
 */
const _processElement = (el, scope = {}) => {
    // 前置校验：快速访问不存在的属性，提前退出
    if (!el || el["__processedcessed"]) return;
    el.__processed = true;  // 标记处理状态
    
    // 缓存节点类型
    const nodeType = el.nodeType;
    
    // 仅处理元素节点
    if (nodeType === Node.ELEMENT_NODE) {
        // 直接调用 _createUpdateFn 并执行，减少变量赋值开销
        const updateFn = _createUpdateFn(el, scope);
        _activeFns.push(updateFn);
        try {
            updateFn();  // 执行更新函数，触发依赖收集
        } finally {
            _activeFns.pop();  // 确保栈清理，避免内存泄漏
        }
    }
    
    // 缓存 childNodes 减少属性访问，提前判断长度避免无效循环
    const childNodes = el.childNodes;
    if (childNodes && childNodes.length) {
        // 缓存正则表达式，避免每次循环创建新实例
        for (let i = 0, len = childNodes.length; i < len; i++) {
            const node = childNodes[i];
            // 短路判断：先检查节点类型，再检查文本内容
            if (node.nodeType === Node.TEXT_NODE && _INTERPOLATION_REGEX.test(node.textContent)) _processTextNode(node, scope);
        }
    }
    
    // 仅当当前节点是元素/文档片段时，才处理子元素
    if ((nodeType === Node.ELEMENT_NODE || nodeType === Node.DOCUMENT_FRAGMENT_NODE) && el.children) {
        const children = el.children;
        const childLen = children.length;
        if (childLen) {
            // 缓存 children 长度，减少循环中对 children.length 的重复访问
            for (let i = 0; i < childLen; i++) _processElement(children[i], scope);  // 递归处理子元素
        }
    }
};


/**
 * 注册指令
 * @param {string} name - 指令名称
 * @param {Function} handler - 指令处理函数
 */
const _registerDirective = (name, handler) => {
    if (typeof handler !== "function") throw new Error(`指令处理器必须是函数: ${name}`);
    _directives.set(name, handler);  // 注册到指令表
};


// r-if 条件渲染指令
_registerDirective("r-if", (el, expr, scope, deps) => {
    // 基础校验：提前拦截无效配置，避免后续报错
    if (!scope || typeof scope !== "object") return void console.warn("[r-if] 作用域无效，条件无法解析");
    
    // 避免重复处理：标记已处理状态，防止同一元素被多次初始化
    if (el.__ifProcessed) return;
    el.__ifProcessed = true;
    
    // 缓存关键数据：初始display获取逻辑，避免重复读取DOM样式
    let __ifInitialDisplay = el.__ifInitialDisplay;
    if (__ifInitialDisplay === undefined) {
        __ifInitialDisplay = el.style.display.trim() || window.getComputedStyle(el).display; // 优先取内联style.display，无则取计算样式，排除"none"的初始异常
        el.__ifInitialDisplay = __ifInitialDisplay === "none" ? "block" : __ifInitialDisplay; // 初始display为"none"时，默认用"block"（避免显隐切换时样式丢失）
    }
    
    // 状态缓存：减少重复解析和DOM操作
    let prevShow = null; // 缓存上一次条件结果，避免相同结果重复执行
    let isFirstRender = true; // 标记是否首次渲染，处理初始状态
    
    // 核心更新函数：逻辑拆分，增加错误容错
    const update = () => {
        let show = false; // 默认值：避免解析失败时样式异常
        try {
            show = _ExpressionParser.parse(expr.trim(), scope, deps); // 解析条件表达式
            show = Boolean(show);
        } catch (parseErr) {
            // 错误容错：解析失败时默认隐藏，同时输出明确日志便于调试
            console.error("[r-if] 条件表达式解析错误:", { expr: expr.trim(), error: parseErr.message, stack: parseErr.stack.slice(0, 300) });
            show = false;
        }
        
        // 结果无变化时跳过DOM操作（减少重排）
        if (show === prevShow && !isFirstRender) return;
        
        // 更新状态和DOM
        prevShow = show;
        isFirstRender = false; // 首次渲染后标记为false
        el.style.display = show ? el.__ifInitialDisplay : "none";
    };
    
    // 依赖收集：确保条件中变量变化时触发更新，增加错误捕获
    _activeFns.push(update);
    
    try {
        update(); // 首次执行：完成初始渲染和依赖收集
    } catch (initErr) {
        console.error("[r-if] 首次渲染错误:", initErr.message);
        el.style.display = "none"; // 初始化失败时默认隐藏，避免页面异常
    } finally {
        _activeFns.pop();
    }
    
    // 自动清理：元素销毁时移除标记，避免内存泄漏
    const cleanIf = () => {
        el.__ifProcessed = false;
        el.removeEventListener("beforeunload", cleanIf);
    };
    el.addEventListener("beforeunload", cleanIf);
});


// r-click 事件指令
_registerDirective("r-click", (el, code, scope) => {
    // 提前返回检查
    if (typeof code !== "string" || !code.trim()) return void console.warn("[r-click] 事件代码不能为空");
    if (!scope || typeof scope !== "object") return void console.warn("[r-click] 作用域无效");
    
    // 一次性获取所有需要的数据
    const eventType = (() => {
        for (const [attr, type] of Object.entries(EVENT_MAP)) if (el.hasAttribute(attr)) return type;
        return "click";
    })();
    
    const isKeyboardEvent = eventType.startsWith("key");
    const keyFilter = isKeyboardEvent ? (el.getAttribute(eventType)?.toLowerCase() || null) : null;
    
    // 提前检查是否需要处理（避免不必要的操作）
    if (el.__clickEventType === eventType && el.__clickCode === code) return;
    
    // 清理函数优化
    const cleanup = () => {
        if (el.__clickHandler) {
            el.removeEventListener(el.__clickEventType, el.__clickHandler);
            el.removeEventListener("beforeunload", cleanup);
            delete el.__clickHandler;
            delete el.__clickFn;
            delete el.__clickEventType;
            delete el.__clickCode;
        }
    };
    
    cleanup(); // 立即清理旧处理器
    
    // 预编译函数
    const validKeys = Object.keys(scope).filter(key => scope[key] !== undefined && typeof scope[key] !== "symbol");
    
    let clickFn;
    try {
        clickFn = new Function(...validKeys, `"use strict";${code}`); // 移除trim()空格
        el.__clickFn = clickFn;
        el.__clickCode = code; // 缓存代码用于比较
    } catch (err) {
        console.error(`[r-click] ${eventType} 编译错误:`, err.message);
        return;
    }
    
    // 事件处理器
    const eventHandler = (event) => {
        // 键盘事件按键过滤
        if (isKeyboardEvent && keyFilter) {
            const normalizedFilter = KEY_MAP[keyFilter] || keyFilter;
            if (event.key.toLowerCase() !== normalizedFilter.toLowerCase() && event.key !== normalizedFilter) return;
            // 优化默认行为阻止逻辑
            if (eventType === "keydown" && event.key === "Enter" && event.target.tagName !== "TEXTAREA") event.preventDefault();
        }
        
        // 右键菜单阻止默认行为
        if (eventType === "contextmenu") event.preventDefault();
        
        // 执行用户函数
        try {
            const values = validKeys.map(key => scope[key]);
            clickFn(...values);
        } catch (err) {
            console.error(`[r-click] 执行错误:`, err);
        }
    };
    
    // 绑定事件
    el.__clickHandler = eventHandler;
    el.__clickEventType = eventType;
    el.addEventListener(eventType, eventHandler, { passive: true });
    
    // 自动清理
    el.addEventListener("beforeunload", cleanup);
});


// r-for 循环指令
_registerDirective("r-for", (el, expr, scope, deps) => {
    // 基础校验：提前拦截无效配置
    if (typeof expr !== "string" || expr.trim() === "") return void console.warn("[r-for] 循环表达式不能为空，请检查配置（如 r-for=\"list.length\"）");
    if (!scope || typeof scope !== "object") return void console.warn("[r-for] 作用域无效，循环次数无法解析");
    
    if (el.__forProcessed) return;
    el.__forProcessed = true;
    
    // 缓存核心数据
    const itemTemplate = el.innerHTML.trim();
    if (!itemTemplate) return void console.warn("[r-for] 循环模板不能为空，请在标签内添加内容");
    const indexKey = el.getAttribute("index") || "index"; // 索引变量名（默认index）
    
    // 缓存基础属性（排除指令相关属性）
    const baseAttrs = {};
    Array.from(el.attributes).forEach(attr => {
        const attrName = attr.name;
        if (["r-for", "index", "class", "style"].includes(attrName)) return;
        baseAttrs[attrName] = _ExpressionParser.parseText(attr.value.trim(), scope, deps);
    });
    
    // 单独缓存class和style，避免样式丢失
    const baseClass = el.className.trim();
    const baseStyle = el.style.cssText.trim();
    
    // 节点缓存：key为循环索引（1开始），value存节点和作用域
    const nodeCache = new Map();
    let prevKeys = new Set(); // 记录上一次的索引集合，用于清理过期节点
    
    // 核心更新函数（索引从1开始）
    const update = () => {
        let count;
        try {
            // 解析循环次数，转为非负整数
            const parsedCount = _ExpressionParser.parse(expr.trim(), scope, deps);
            count = Math.max(0, parseInt(parsedCount, 10) || 0);
        } catch (parseErr) {
            console.error("[r-for] 解析错误:", { expr: expr.trim(), error: parseErr.message });
            count = 0; // 解析失败时默认不渲染
        }
        
        // 生成当前循环的索引集合（从1开始）
        const currKeys = Array.from({ length: count }, (_, i) => i + 1);
        const currKeySet = new Set(currKeys);
        const fragment = document.createDocumentFragment();
        
        // 处理节点复用与创建
        currKeys.forEach(key => {
            const index = key;
            let cacheEntry = nodeCache.get(key);
            let nodesToAdd;
            
            // 复用已有节点
            if (cacheEntry) {
                const { nodes, itemScope } = cacheEntry;
                // 更新作用域中的索引
                itemScope[indexKey] = index;
                
                // 重新处理节点依赖（如内部r-if/r-click）
                const reuseFragment = document.createDocumentFragment();
                nodes.forEach(node => {
                    node.__processed = false;
                    if (node.children) Array.from(node.children).forEach(child => child.__processed = false);
                    reuseFragment.appendChild(node);
                });
                
                _processElement(reuseFragment, itemScope);
                nodesToAdd = reuseFragment;
            } else {
                // 创建新节点
                const tempContainer = document.createElement("div");
                
                // 应用基础样式和属性
                if (baseClass) tempContainer.className = baseClass;
                if (baseStyle) tempContainer.style.cssText = baseStyle;
                Object.entries(baseAttrs).forEach(([name, value]) => tempContainer.setAttribute(name, value));
                
                // 填充模板
                tempContainer.innerHTML = itemTemplate;
                
                // 生成作用域
                const itemScope = reactive({ ...scope, [indexKey]: index });
                
                // 处理节点响应式
                _processElement(tempContainer, itemScope);
                
                // 提取节点并缓存
                const newFragment = document.createDocumentFragment();
                const nodeArray = Array.from(tempContainer.childNodes);
                nodeCache.set(key, { nodes: nodeArray, itemScope });
                nodeArray.forEach(node => newFragment.appendChild(node));
                nodesToAdd = newFragment;
            }
            fragment.appendChild(nodesToAdd);
        });
        
        // 清理过期节点
        prevKeys.forEach(key => !currKeySet.has(key) && nodeCache.delete(key));
        prevKeys = currKeySet;
        
        // 批量更新DOM
        el.textContent = "";
        el.appendChild(fragment);
    };
    
    // 依赖收集与首次渲染
    _activeFns.push(update);
    try {
        update();
    } catch (initErr) {
        console.error("[r-for] 初始化错误:", initErr.message);
        el.textContent = "";
    } finally {
        _activeFns.pop();
    }
    
    // 自动清理：避免内存泄漏
    const cleanFor = () => {
        nodeCache.clear();
        prevKeys.clear();
        el.__forProcessed = false;
        el.removeEventListener("beforeunload", cleanFor);
    };
    
    el.addEventListener("beforeunload", cleanFor);
    
    // 依赖更新：变量变化时重新渲染
    const elDeps = _elDeps.get(el) || new Set();
    elDeps.forEach(varName => _depsMap.get(scope)?.subscribe(update, varName));
});


// r-arr 数据循环指令
_registerDirective("r-arr", (el, expr, scope, deps) => {
    // 基础校验
    if (typeof expr !== "string" || expr.trim() === "") return void console.warn("[r-arr] 数组表达式不能为空（如 r-arr=\"list\"）");
    if (!scope || typeof scope !== "object") return void console.warn("[r-arr] 作用域无效，无法解析数组");
    
    if (el.__arrProcessed) return;
    el.__arrProcessed = true;
    
    // 缓存核心配置（减少重复DOM读取）
    const itemTemplate = el.innerHTML.trim();
    if (!itemTemplate) return void console.warn("[r-arr] 循环模板不能为空，请在标签内添加内容");
    
    const indexKey = el.getAttribute("index") || "index"; // 索引变量名（默认index）
    const itemKey = el.getAttribute("value") || "value"; // 项变量名（默认value）
    const keyProp = el.getAttribute("key") || "id"; // 唯一键属性（默认id）
    
    // 缓存基础属性（过滤指令相关属性，避免重复解析）
    const baseAttrs = {};
    const baseClass = el.className.trim(); // 单独缓存class（避免样式丢失）
    const baseStyle = el.style.cssText.trim(); // 单独缓存style
    Array.from(el.attributes).forEach(attr => {
        const name = attr.name;
        if (["r-arr", "index", "value", "key", "class", "style"].includes(name)) return;
        baseAttrs[name] = _ExpressionParser.parseText(attr.value.trim(), scope, deps);
    });
    
    // 节点缓存（高效复用）
    const nodeCache = new Map(); // key: 唯一键, value: { nodes: Node[], scope: 响应式作用域 }
    let prevKeySet = new Set(); // 上一次的唯一键集合（用于快速对比）
    
    // 唯一键生成函数（解决复杂数据的键冲突问题）
    const getUniqueKey = (item, index) => {
        // 优先使用item的keyProp（如id）
        if (item && typeof item === "object" && item[keyProp] !== undefined) return String(item[keyProp]); // 转为字符串，避免数字/字符串键冲突
        
        // 无keyProp时，用索引+数据摘要（减少长数据的JSON序列化开销）
        const dataHash = typeof item === "object" ? JSON.stringify(item).slice(0, 50) : String(item);
        return `${index}-${dataHash}`;
    };
    
    // 核心更新函数
    const update = () => {
        let arr = [];
        try {
            // 解析数组表达式（支持响应式数据）
            const parsed = _ExpressionParser.parse(expr.trim(), scope, deps);
            arr = Array.isArray(parsed) ? parsed : []; // 非数组转为空数组
        } catch (parseErr) {
            console.error("[r-arr] 数组解析错误:", { expr: expr.trim(), error: parseErr.message, stack: parseErr.stack.slice(0, 300) });
            arr = []; // 解析失败时渲染空
        }
        
        // 生成当前数组的唯一键列表
        const currKeys = arr.map((item, i) => getUniqueKey(item, i));
        const currKeySet = new Set(currKeys);
        const fragment = document.createDocumentFragment(); // 批量处理DOM
        
        // 处理每个数组项（复用/创建节点）
        currKeys.forEach((currKey, index) => {
            const itemData = arr[index];
            const cached = nodeCache.get(currKey);
            let nodesToAdd;
            
            if (cached) {
                // 复用已有节点
                const { nodes, itemScope } = cached;
                // 更新作用域数据（保持响应式）
                itemScope[itemKey] = itemData;
                itemScope[indexKey] = index;
                
                // 复用节点时：克隆节点避免DOM节点被多次插入
                const reuseFragment = document.createDocumentFragment();
                nodes.forEach(node => {
                    const cloned = node.cloneNode(true); // 深克隆节点
                    cloned.__processed = false; // 重置处理标记，重新收集依赖
                    if (cloned.children) Array.from(cloned.children).forEach(child => child.__processed = false);
                    reuseFragment.appendChild(cloned);
                });
                
                // 重新处理节点内的指令
                _processElement(reuseFragment, itemScope);
                nodesToAdd = reuseFragment;
            } else {
                // 创建新节点
                const tempContainer = document.createElement("div");
                
                // 应用基础样式和属性（避免样式丢失）
                if (baseClass) tempContainer.className = baseClass;
                if (baseStyle) tempContainer.style.cssText = baseStyle;
                Object.entries(baseAttrs).forEach(([name, value]) => tempContainer.setAttribute(name, value));
                
                // 填充模板内容
                tempContainer.innerHTML = itemTemplate;
                
                // 创建响应式作用域
                const itemScope = reactive({ ...scope, [itemKey]: itemData, [indexKey]: index });
                
                // 处理节点内的响应式指令
                _processElement(tempContainer, itemScope);
                
                // 提取节点数组并缓存（用于下次复用）
                const nodes = Array.from(tempContainer.childNodes);
                nodeCache.set(currKey, { nodes, itemScope });
                
                // 加入fragment
                const newFragment = document.createDocumentFragment();
                nodes.forEach(node => newFragment.appendChild(node));
                nodesToAdd = newFragment;
            }
            fragment.appendChild(nodesToAdd);
        });
        
        // 清理过期缓存（删除不在当前数组中的节点）
        prevKeySet.forEach(key => !currKeySet.has(key) && nodeCache.delete(key));
        prevKeySet = currKeySet;
        
        // 批量渲染到DOM（减少重排）
        el.textContent = "";
        el.appendChild(fragment);
    };
    
    // 依赖收集与首次渲染
    _activeFns.push(update);
    try {
        update(); // 首次执行，完成初始渲染和依赖收集
    } catch (initErr) {
        console.error("[r-arr] 初始化错误:", initErr.message);
        el.textContent = ""; // 初始化失败时清空，避免异常内容
    } finally {
        _activeFns.pop();
    }
    
    // 自动清理：元素销毁时释放缓存（避免内存泄漏）
    const cleanArr = () => {
        nodeCache.clear();
        prevKeySet.clear();
        el.__arrProcessed = false;
        el.removeEventListener("beforeunload", cleanArr);
    };
    el.addEventListener("beforeunload", cleanArr);
    
    // 响应式关联：数组或依赖变量变化时触发更新
    const elDeps = _elDeps.get(el) || new Set();
    elDeps.forEach(varName => _depsMap.get(scope)?.subscribe(update, varName));
});


// r-api 请求指令
_registerDirective("r-api", async (el, urlExpr, scope, deps) => {
    if (el.__apiProcessed) return;
    el.__apiProcessed = true;
    
    // 核心状态
    let isRequestDone = false;
    let currentData = null;
    let lastRenderedData = null;
    const nodeCache = new Map();
    const templateHTML = el.innerHTML;
    
    // 配置解析
    const getConfig = () => {
        const headersAttr = el.getAttribute("hdr");
        const headers = headersAttr ? JSON.parse(_ExpressionParser.parse(headersAttr, scope, deps) || "{}") : { "Content-Type": "application/json" };
        return {
            method: (el.getAttribute("meth") || "GET").toUpperCase(),
            headers,
            listKey: el.getAttribute("list"),
            itemKey: el.getAttribute("key") || "id",
            templateVar: el.getAttribute("value") || "value",
            indexKey: el.getAttribute("index") || "index",
            arrKey: el.getAttribute("arr"),
            refreshSelector: el.getAttribute("refr"),
            isManualLoad: el.hasAttribute("aw")
        };
    };
    
    const config = getConfig();
    
    // 动态解析URL（修复关键点）
    const parseDynamicUrl = () => {
        // 创建临时依赖收集器
        const urlDeps = new Set();
        
        // 解析URL表达式，支持动态变量
        let requestUrl = urlExpr;
        
        // 如果包含插值表达式，进行解析
        if (_INTERPOLATION_REGEX.test(urlExpr)) requestUrl = _ExpressionParser.parseText(urlExpr, scope, urlDeps);
        else {
            // 即使没有插值，也要检查是否是变量引用
            const vars = urlExpr.match(_VARIABLE_REGEX) || [];
            vars.forEach(v => {
                const rootVar = v.split(".")[0];
                if (rootVar && !_ExpressionParser._globals.has(rootVar)) {
                    urlDeps.add(rootVar);
                    // 尝试从作用域获取变量值
                    try {
                        const value = _ExpressionParser.parse(urlExpr, scope, new Set());
                        if (value && typeof value === "string") requestUrl = value;
                    } catch (e) {
                    }
                }
            });
        }
        
        return { requestUrl, urlDeps };
    };
    
    // 创建基础作用域
    const createBaseScope = (data) => {
        const baseScope = { ...scope, _aw: isRequestDone };
        if (config.arrKey) baseScope[config.arrKey] = data;
        return reactive(baseScope);
    };
    
    // 渲染数组数据
    const renderArray = (data, fragment) => {
        data.forEach((item, index) => {
            const itemUniqueKey = item[config.itemKey] ?? index;
            let cachedNode = nodeCache.get(itemUniqueKey);
            
            if (cachedNode) {
                cachedNode.scope[config.templateVar] = item;
                cachedNode.scope[config.indexKey] = index;
                cachedNode.scope._aw = isRequestDone;
            } else {
                const tempContainer = document.createElement("div");
                tempContainer.innerHTML = templateHTML;
                const itemScope = reactive({ ...scope, [config.templateVar]: item, [config.indexKey]: index, _aw: isRequestDone });
                _processElement(tempContainer, itemScope);
                const itemFragment = document.createDocumentFragment();
                Array.from(tempContainer.childNodes).forEach(node => itemFragment.appendChild(node));
                cachedNode = { el: itemFragment, scope: itemScope };
                nodeCache.set(itemUniqueKey, cachedNode);
            }
            fragment.appendChild(cachedNode.el);
        });
    };
    
    // 渲染对象数据
    const renderObject = (data, fragment) => {
        const objScope = reactive({ ...scope, [config.templateVar]: data, _aw: isRequestDone });
        const tempContainer = document.createElement("div");
        tempContainer.innerHTML = templateHTML;
        _processElement(tempContainer, objScope);
        Array.from(tempContainer.childNodes).forEach(node => fragment.appendChild(node));
    };
    
    // 核心渲染函数
    const renderTemplate = (data) => {
        if (JSON.stringify(data) === JSON.stringify(lastRenderedData)) return;
        
        el.textContent = "";
        const fragment = document.createDocumentFragment();
        const baseScope = createBaseScope(data);
        
        if (config.arrKey) {
            const tempContainer = document.createElement("div");
            tempContainer.innerHTML = templateHTML;
            _processElement(tempContainer, baseScope);
            Array.from(tempContainer.childNodes).forEach(node => fragment.appendChild(node));
        } else if (Array.isArray(data)) renderArray(data, fragment);
        else if (data && typeof data === "object") renderObject(data, fragment);
        
        el.appendChild(fragment);
        lastRenderedData = data;
    };
    
    // 接口请求
    const fetchAndRender = async () => {
        isRequestDone = false;
        renderTemplate(currentData);
        
        try {
            // 动态解析URL
            const { requestUrl } = parseDynamicUrl();
            if (!requestUrl) new Error("API URL不能为空");
            const needBody = ["POST", "PUT", "PATCH"].includes(config.method);
            const requestBody = needBody ? JSON.stringify(_ExpressionParser.parse(el.getAttribute("data-body") || "{}", scope, deps)) : null;
            
            const response = await fetch(requestUrl, {
                method: config.method,
                headers: config.headers,
                body: requestBody
            });
            
            if (!response.ok) new Error(`请求失败：${response.status} ${response.statusText}`);
            
            const responseData = await response.json();
            currentData = config.listKey ? responseData[config.listKey] : responseData;
            
            isRequestDone = true;
            renderTemplate(currentData);
        } catch (error) {
            console.error("[r-api] 请求错误：", error.message);
            isRequestDone = true;
            renderTemplate(null);
        }
    };
    
    // 初始渲染
    const init = () => {
        const initScope = createBaseScope(null);
        const fragment = document.createDocumentFragment();
        const itemFragment = document.createDocumentFragment();
        
        Array.from(el.childNodes).forEach(node => itemFragment.appendChild(node.cloneNode(true)));
        fragment.appendChild(itemFragment);
        _activeFns.push(() => _processElement(fragment, initScope));
        
        try {
            _activeFns[_activeFns.length - 1]();
        } finally {
            _activeFns.pop();
        }
        
        el.textContent = "";
        el.appendChild(fragment);
        renderTemplate(null);
    };
    
    // 动态URL依赖收集
    const setupDynamicUrlDependency = () => {
        const { urlDeps } = parseDynamicUrl();
        // 为URL中的每个依赖变量设置监听
        urlDeps.forEach(varName => _depsMap.get(scope)?.subscribe(async () => await fetchAndRender(), varName));
    };
    
    // 执行初始化
    if (!config.isManualLoad) await fetchAndRender();
    else init();
    
    // 设置动态URL依赖监听
    setupDynamicUrlDependency();
    
    // 刷新按钮绑定
    if (config.refreshSelector) {
        const refreshBtn = document.querySelector(config.refreshSelector);
        if (refreshBtn && !refreshBtn.__apiRefreshHandler) {
            refreshBtn.__apiRefreshHandler = () => fetchAndRender();
            refreshBtn.addEventListener("click", refreshBtn.__apiRefreshHandler);
            
            el.addEventListener("beforeunload", () => {
                refreshBtn.removeEventListener("click", refreshBtn.__apiRefreshHandler);
                refreshBtn.__apiRefreshHandler = null;
            });
        }
    }
    
    // 原有依赖监听
    const elDeps = _elDeps.get(el) || new Set();
    elDeps.forEach(varName => _depsMap.get(scope)?.subscribe(async () => await fetchAndRender(), varName));
});


// r-model 双向绑定指令
_registerDirective("r-model", (el, path, scope) => {
    // 解析模型路径并返回访问器
    const resolvePath = (pathStr, currentScope) => {
        const pathSegments = pathStr.split(".");
        
        // getter 函数：负责安全地从作用域中读取值
        const get = () => {
            let target = currentScope;
            
            // 遍历除最后一段外的所有路径
            for (let i = 0; i < pathSegments.length - 1; i++) {
                const seg = pathSegments[i];
                if (target[seg]?.__isRef) target = target[seg].value; else if (target[seg]?.__isReactive) target = target[seg]; else return undefined;
            }
            
            // 获取最终目标属性
            const lastSeg = pathSegments[pathSegments.length - 1];
            
            // 如果最终目标是 ref，返回其 .value
            if (target[lastSeg]?.__isRef) return target[lastSeg].value;
            return target[lastSeg]; // 否则，返回普通属性值
        };
        
        // setter 函数：负责安全地将值写入作用域
        const set = (newValue) => {
            let target = currentScope;
            
            // 遍历除最后一段外的所有路径
            for (let i = 0; i < pathSegments.length - 1; i++) {
                const seg = pathSegments[i];
                if (target[seg]?.__isRef) target = target[seg].value; else if (target[seg]?.__isReactive) target = target[seg];
                else {
                    target[seg] = reactive({});
                    target = target[seg];
                }
            }
            
            const lastSeg = pathSegments[pathSegments.length - 1];
            
            // 如果最终目标是 ref，更新其 .value 属性
            if (target[lastSeg]?.__isRef) target[lastSeg].value = newValue; else target[lastSeg] = newValue;
        };
        
        return { get, set };
    };
    
    // 缓存路径解析结果，得到 getter 和 setter 函数
    const { get: getModelValue, set: setModelValue } = resolvePath(path, scope);
    
    // 更新视图以反映模型数据
    const updateView = () => {
        const modelValue = getModelValue(); // 从模型中获取最新值
        let viewValue; // 用于存储当前DOM中的值
        
        // 根据元素类型获取当前视图值
        if (el.type === "checkbox") viewValue = el.checked; else if (el.type === "radio") viewValue = el.checked; else viewValue = el.value;
        
        // 比较模型值和视图值，判断是否需要更新
        let shouldUpdate;
        if (el.type === "checkbox") shouldUpdate = !!modelValue !== viewValue; // 转换为布尔值再比较
        else if (el.type === "radio") shouldUpdate = (el.value === modelValue) !== viewValue; else shouldUpdate = String(modelValue ?? "") !== viewValue; // 统一转为字符串比较
        
        // 只有当值确实不同时，才执行DOM更新操作
        if (shouldUpdate) {
            if (el.type === "checkbox") el.checked = !!modelValue; else if (el.type === "radio") el.checked = el.value === modelValue; else if (el.tagName === "SELECT") el.value = modelValue; else el.value = modelValue != null ? String(modelValue) : "";
        }
    };
    
    // 更新模型以反映视图变化
    const updateModel = () => {
        let newValue; // 用于存储从DOM中获取的新值
        
        // 根据元素类型获取新值
        if (el.type === "checkbox") newValue = el.checked; else if (el.type === "radio") {
            if (!el.checked) return; // 只有选中的 radio 才触发更新
            newValue = el.value;
        } else if (el.tagName === "SELECT") newValue = el.value;
        else newValue = el.type === "number" && !isNaN(el.value) ? parseFloat(el.value) : el.value;
        
        // 获取旧的模型值进行比较
        const oldValue = getModelValue();
        // 只有当新值和旧值不同时，才更新模型（这会触发依赖更新）
        if (oldValue !== newValue) setModelValue(newValue);
    };
    
    // 根据元素类型确定要监听的事件
    const eventType = el.tagName === "SELECT" ? "change" : ["checkbox", "radio"].includes(el.type) ? "change" : "input";
    
    // 如果元素上已经存在旧的 r-model 事件处理器，先移除它，防止重复绑定
    if (el.__modelHandler) el.removeEventListener(el.__modelEventType || "input", el.__modelHandler);
    
    // 缓存新的事件处理器和事件类型，方便后续清理
    el.__modelHandler = updateModel;
    el.__modelEventType = eventType;
    
    // 绑定新的事件处理器
    el.addEventListener(eventType, updateModel);
    
    // 强制进行一次依赖收集和初始渲染
    _activeFns.push(updateView);
    try {
        updateView();
    } finally {
        _activeFns.pop();
    }
    
    // 定义一个清理函数，用于在元素被销毁时释放资源
    const cleanup = () => {
        if (el.__modelHandler) {
            el.removeEventListener(el.__modelEventType, el.__modelHandler);
            el.__modelHandler = null; // 释放引用
        }
        
        // 移除自身的清理监听，防止循环引用
        el.removeEventListener("beforeunload", cleanup);
    };
    
    // 监听元素的 beforeunload 事件，在元素即将从DOM中移除时执行清理
    el.addEventListener("beforeunload", cleanup);
});


// r-cp 组件化指令
_registerDirective("r-cp", (el, compName, scope, deps) => {
    // 避免重复处理组件实例
    if (el.__cpProcessed) return;
    el.__cpProcessed = true;
    
    // 校验组件是否存在
    const compTemplate = _componentTemplates.get(compName.trim());
    if (!compTemplate) return void console.error(`[r-cp] 组件 "${compName}" 未定义，请先通过 <template r-cp="${compName}"> 定义`);
    
    // 提取组件传入的属性
    const getComponentProps = () => {
        const props = {};
        Array.from(el.attributes).forEach(attr => {
            if (attr.name.startsWith("$")) {
                const propKey = attr.name.slice(1);
                props[propKey] = _ExpressionParser.parse(attr.value, scope, deps);
            }
        });
        return props;
    };
    
    // 修改组件作用域创建逻辑（直接将属性挂载到作用域根节点）
    const createComponentScope = () => {
        const props = getComponentProps();
        // 组件作用域：继承根作用域 + 直接挂载$属性
        const compScope = reactive({ ...window.__rootScope, ...props, $isComponent: true });
        _componentInstances.set(el, compScope);
        return compScope;
    };
    
    // 渲染组件（克隆模板 + 绑定作用域 + 处理响应式）
    const renderComponent = () => {
        const compScope = createComponentScope();
        const templateClone = compTemplate.cloneNode(true);
        _processElement(templateClone, compScope);
        el.textContent = "";
        el.appendChild(templateClone);
    };
    
    // 初始渲染 + 依赖收集（属性变化时重新渲染）
    _activeFns.push(renderComponent);
    try {
        renderComponent();
    } finally {
        _activeFns.pop();
    }
    
    // 监听属性变化
    const elDeps = _elDeps.get(el) || new Set();
    elDeps.forEach(varName => _depsMap.get(scope)?.subscribe(renderComponent, varName));
    
    // 组件销毁清理（避免内存泄漏）
    const cleanup = () => {
        _componentInstances.delete(el);
        el.__cpProcessed = false;
        el.removeEventListener("beforeunload", cleanup);
    };
    
    el.addEventListener("beforeunload", cleanup);
});


// r-route 路由指令
_registerDirective("r-route", (el, pathExpr, scope, deps) => {
    const path = _ExpressionParser.parse(pathExpr, scope, deps);
    if (!path) return;
    
    // 清理旧处理器
    if (el._routeHandler) el.removeEventListener("click", el._routeHandler);
    
    // 创建新处理器
    el._routeHandler = (event) => {
        event.preventDefault();
        if (path && router.routes.has(path)) router.nav(path);
    };
    
    el.addEventListener("click", el._routeHandler);
    
    // 自动清理
    const cleanup = () => {
        el.removeEventListener("click", el._routeHandler);
        delete el._routeHandler;
    };
    
    el.addEventListener("beforeunload", cleanup);
});


// r 指令
_registerDirective("r", (el, refExpr, scope, deps) => {
    if (typeof refExpr !== "string" || !refExpr.trim()) return;
    if (!window.$r) window.$r = {};
    let currentRefName = null;
    let isDynamic = false; // 标记是否为动态引用
    
    // 解析引用名：支持静态字符串和动态插值
    const getRefName = () => {
        let name = refExpr.trim();
        
        // 检测是否包含插值表达式
        if (_INTERPOLATION_REGEX.test(name)) {
            isDynamic = true;
            return _ExpressionParser.parseText(name, scope, deps)?.toString().trim() || null; // 解析动态插值
        } else {
            isDynamic = false;
            return name; // 静态字符串直接使用
        }
    };
    
    // 更新引用
    const updateRef = () => {
        const newName = getRefName();
        if (!newName) return;
        
        if (newName !== currentRefName) {
            // 清理旧引用
            if (currentRefName && window.$r[currentRefName] === el) delete window.$r[currentRefName];
            
            // 设置新引用
            currentRefName = newName;
            window.$r[currentRefName] = el;
        }
    };
    
    // 初始设置
    currentRefName = getRefName();
    if (currentRefName) window.$r[currentRefName] = el;
    
    // 只有动态引用才需要响应式更新
    if (isDynamic) {
        // 设置响应式更新
        _activeFns.push(updateRef);
        try {
            getRefName(); // 触发依赖收集
        } finally {
            _activeFns.pop();
        }
        
        // 收集依赖
        const dependencies = new Set();
        _ExpressionParser.parseText(refExpr, scope, dependencies);
        dependencies.forEach(varName => _depsMap.get(scope)?.subscribe(updateRef, varName)); // 订阅变化
    }
    
    // 清理
    el.addEventListener("beforeunload", () => (currentRefName && window.$r[currentRefName] === el) && delete window.$r[currentRefName]);
});


// r-dom 指令
_registerDirective("r-dom", (el, compName, scope, deps) => {
    // 避免重复处理
    if (el.__domProcessed) return;
    el.__domProcessed = true;
    const compNameTrimmed = compName.trim();
    
    // 组件模板存在性校验（提前失败）
    if (!_componentTemplates.has(compNameTrimmed)) return void console.error(`[r-dom] 组件 "${compNameTrimmed}" 未定义，请先通过 dom("${compNameTrimmed}", {...}) 定义`);
    
    // 组件实例状态管理
    let componentInstance = null;
    let retryTimer = null;
    let retryCount = 0;
    const MAX_RETRY_COUNT = 3; // 最大重试次数
    const RETRY_INTERVAL = 60; // 重试间隔(ms)
    
    // 提取组件 props
    const getComponentProps = () => {
        const props = {};
        const attributes = el.attributes;
        
        for (let i = 0; i < attributes.length; i++) {
            const attr = attributes[i];
            if (attr.name.startsWith("$")) {
                const propKey = attr.name.slice(1);
                // 使用try-catch避免单个属性解析失败影响整体
                try {
                    props[propKey] = _ExpressionParser.parse(attr.value, scope, deps);
                } catch (error) {
                    console.warn(`[r-dom] 属性 "${attr.name}" 解析失败:`, error);
                    props[propKey] = attr.value; // 降级为原始值
                }
            }
        }
        return props;
    };
    
    // 查找组件工厂函数
    const findComponentFactory = () => scope[compNameTrimmed] || window[compNameTrimmed] || (window.__rootScope && window.__rootScope[compNameTrimmed]);
    
    // 渲染组件
    const renderComponent = (ComponentFactory) => {
        // 清理旧实例
        if (componentInstance) {
            try {
                if (typeof componentInstance.unmount === "function") componentInstance.unmount();
            } catch (unmountError) {
                console.warn(`[r-dom] 组件卸载失败:`, unmountError);
            }
            componentInstance = null;
        }
        
        const props = getComponentProps();
        
        try {
            // 支持多种调用方式
            if (ComponentFactory.length >= 2) componentInstance = ComponentFactory(props, el);
            else componentInstance = ComponentFactory({ props, target: el });
            
            // 验证组件实例
            if (!componentInstance) new Error("组件工厂函数未返回有效实例");
            _componentInstances.set(el, componentInstance);
        } catch (error) {
            console.error(`[r-dom] 组件 "${compNameTrimmed}" 渲染失败:`, error);
        }
    };
    
    // 组件挂载流程
    const mountComponent = () => {
        const ComponentFactory = findComponentFactory();
        if (typeof ComponentFactory === "function") {
            // 找到组件，停止重试并渲染
            if (retryTimer) {
                clearInterval(retryTimer);
                retryTimer = null;
            }
            renderComponent(ComponentFactory);
            return true;
        }
        return false;
    };
    
    // 重试机制（带指数退避）
    const startRetry = () => {
        if (retryTimer) return;
        retryTimer = setInterval(() => {
            retryCount++;
            if (mountComponent()) return; // 成功挂载
            if (retryCount >= MAX_RETRY_COUNT) {
                // 超时处理
                clearInterval(retryTimer);
                retryTimer = null;
                console.error(`[r-dom] 组件 "${compNameTrimmed}" 注册超时（${MAX_RETRY_COUNT * RETRY_INTERVAL}ms）`);
            }
        }, RETRY_INTERVAL);
    };
    
    // 依赖变化时的处理（防抖优化）
    let pendingUpdate = null;
    const handleDependencyChange = () => {
        if (pendingUpdate) clearTimeout(pendingUpdate);
        
        pendingUpdate = setTimeout(() => {
            // 重新检查组件是否可用
            const ComponentFactory = findComponentFactory();
            if (typeof ComponentFactory === "function") renderComponent(ComponentFactory);
            else if (componentInstance) { // props变化但组件未重新注册，也触发更新
                // 如果组件实例存在但工厂函数丢失，尝试重新创建
                console.warn(`[r-dom] 组件工厂函数丢失，尝试重新挂载`);
                startRetry();
            }
            pendingUpdate = null;
        }, 16); // 约一帧的时间
    };
    
    // 初始挂载
    if (!mountComponent()) startRetry(); // 组件未就绪，启动重试机制
    
    
    // 响应式依赖收集（优化版本）
    const elDeps = _elDeps.get(el) || new Set();
    const collectedDeps = new Set();
    
    // 收集props中的依赖
    const props = getComponentProps();
    Object.values(props).forEach(value => {
        if (typeof value === "string" && value.includes("{{")) {
            const vars = value.match(_VARIABLE_REGEX) || [];
            vars.forEach(v => {
                const rootVar = v.split(".")[0];
                if (rootVar && !_ExpressionParser._globals.has(rootVar)) collectedDeps.add(rootVar);
            });
        }
    });
    
    // 合并依赖并订阅
    const allDeps = new Set([...elDeps, ...collectedDeps]);
    allDeps.forEach(varName => _depsMap.get(scope)?.subscribe(handleDependencyChange, varName));
    
    // 清理逻辑（增强版本）
    const cleanup = () => {
        // 清理重试计时器
        if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = null;
        }
        
        // 清理更新计时器
        if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = null;
        }
        
        // 卸载组件实例
        if (componentInstance) {
            try {
                if (typeof componentInstance.unmount === "function") componentInstance.unmount();
            } catch (error) {
                console.warn(`[r-dom] 组件卸载异常:`, error);
            }
            componentInstance = null;
        }
        
        // 清理实例映射
        _componentInstances.delete(el);
        el.__domProcessed = false;
        el.removeEventListener("beforeunload", cleanup);
    };
    
    el.addEventListener("beforeunload", cleanup);
});


// 路由管理器
const _Router = {
    routes: new Map(),
    currentPath: "",
    pageContainers: new Map(), // 存储所有页面的容器元素
    originalPageElements: new Map(), // 存储原始页面元素的HTML内容
    
    // 添加路由
    add(path, handler) {
        if (typeof handler !== "function") return;
        this.routes.set(path, handler);
    },
    
    // 解析URL中的路径参数
    _parsePath() {
        try {
            const url = new URL(window.location.href);
            return url.searchParams.get("path") || "";
        } catch {
            return "";
        }
    },
    
    // 导航到指定路径
    nav(path, replace = false) {
        setTimeout(() => {
            if (!this.routes.has(path)) {
                console.warn(`路由不存在: ${path}`);
                return;
            }
            
            try {
                const url = new URL(window.location.href);
                url.searchParams.set("path", path);
                if (replace) window.history.replaceState({}, "", url);
                else window.history.pushState({}, "", url);
                this._executeRoute(path);
            } catch (error) {
                console.error("路由导航失败:", error);
            }
        }, 5);
    },
    
    // 执行指定路径的路由处理器
    _executeRoute(path) {
        if (this.currentPath === path) return;
        
        // 隐藏所有页面
        this.pageContainers.forEach((container) => container.style.display = "none");
        
        // 显示目标页面
        const targetContainer = this.pageContainers.get(path);
        if (targetContainer) targetContainer.style.display = "block";
        this.currentPath = path;
        
        const handler = this.routes.get(path);
        if (handler) {
            try {
                handler();
            } catch (error) {
                console.error(`路由执行错误 [${path}]:`, error);
            }
        }
    },
    
    // 预渲染所有页面
    _prerenderAllPages() {
        const routerView = document.getElementById("view");
        if (!routerView) return;
        
        // 清除可能存在的旧内容
        routerView.innerHTML = "";
        
        // 渲染所有注册的路由页面
        this.routes.forEach((_, path) => this._renderPage(path, routerView));
    },
    
    // 渲染单个页面
    _renderPage(path, container) {
        // 创建页面容器
        const pageContainer = document.createElement("div");
        pageContainer.className = "route-page";
        pageContainer.setAttribute("data-route-path", path);
        pageContainer.style.display = "none"; // 默认隐藏
        
        // 存储页面容器
        this.pageContainers.set(path, pageContainer);
        
        // 获取原始页面元素的HTML内容
        const originalHTML = this.originalPageElements.get(path);
        if (originalHTML) {
            pageContainer.innerHTML = originalHTML;
            
            // 处理动态内容
            _processElement(pageContainer, window.__rootScope || {});
        }
        
        container.appendChild(pageContainer);
    },
    
    init() {
        // 首先收集所有页面内容并移除原始元素
        this._collectAndRemoveOriginalPages();
        
        // 初始路由
        const initialPath = this._parsePath();
        
        // 预渲染所有页面
        this._prerenderAllPages();
        
        // 执行初始路由
        if (initialPath && this.routes.has(initialPath)) this._executeRoute(initialPath);
        
        // 浏览器前进后退
        this._popstateHandler = () => {
            const path = this._parsePath();
            if (path && path !== this.currentPath) this._executeRoute(path);
        };
        
        window.addEventListener("popstate", this._popstateHandler);
    },
    
    // 收集所有原始页面内容并从DOM中移除
    _collectAndRemoveOriginalPages() {
        const pageElements = document.querySelectorAll("[r-page]");
        
        pageElements.forEach(pageElement => {
            const pageName = pageElement.getAttribute("r-page");
            if (pageName) {
                // 保存HTML内容
                this.originalPageElements.set(pageName, pageElement.innerHTML);
                
                // 注册路由
                this.add(pageName, new Function());
                
                // 从DOM中移除原始元素
                pageElement.remove();
            }
        });
    }
};
window.router = _Router;


/**
 * 创建响应式引用（用于基本类型数据）
 * @param {*} initialValue - 初始值
 * @returns {Object} ref对象（包含value属性的访问器）
 * 原理：通过value的getter/setter拦截访问和修改，实现依赖收集和通知
 */
window.ref = (initialValue) => {
    const dep = new _Dependency();  // 该ref的依赖管理器
    let value = initialValue;      // 内部存储的实际值
    
    return {
        // getter：当访问value时收集依赖
        get value() {
            // 收集依赖：当有活跃的更新函数访问value时，将其加入订阅者
            if (_activeFns.length > 0) dep.subscribe(_activeFns[_activeFns.length - 1]);
            return value;
        },
        
        // setter：当设置value时通知依赖更新
        set value(newValue) {
            if (value !== newValue) {  // 避免无意义的更新
                value = newValue;
                dep.notify();  // 通知所有订阅者更新
            }
        },
        
        __isRef: true  // 标记为ref对象，便于识别
    };
};


/**
 * 创建响应式对象（用于对象/数组）
 * @param {Object} target - 目标对象
 * @returns {Object} 响应式代理对象
 * 原理：通过Proxy拦截对象的get/set/delete等操作，实现依赖收集和通知
 */
window.reactive = (target) => {
    // 过滤非对象/数组类型（基础类型、null、日期、正则、函数等）
    if (typeof target !== "object" || target === null || target instanceof Date || target instanceof RegExp || target instanceof Function || target instanceof Map || target instanceof Set) {
        console.warn(`[reactive] 仅支持纯对象/数组类型，当前类型: ${typeof target} (${target?.constructor?.name})`);
        return target;
    }
    
    // 当前对象已是代理对象（直接返回，无需二次代理）
    if (target.__isReactiveProxy) return target;
    if (target.__isReactive) return _depsMap.get(target).__proxy || target;
    
    // 原始对象（未被代理过）：存储原始引用，避免嵌套代理时丢失
    const rawTarget = target;
    
    const dep = new _Dependency();
    _depsMap.set(rawTarget, dep); // 存储：原始对象 → 依赖实例（用于后续嵌套访问时复用）
    
    // 原始对象标记（不可枚举，避免污染用户数据）
    Object.defineProperties(rawTarget, {
        __isReactive: { value: true, enumerable: false, configurable: false }, // 标记已被代理
        __raw: { value: rawTarget, enumerable: false, configurable: false }    // 原始对象自引用
    });
    
    const arrayMethods = ["push", "pop", "shift", "unshift", "splice", "sort", "reverse"];
    const optimizeArray = (arr) => {
        // 创建数组方法代理（基于原型链，不污染全局Array）
        const arrayProxyProto = Object.create(Array.prototype);
        arrayMethods.forEach(method => {
            arrayProxyProto[method] = function (...args) {
                // 临时关闭依赖通知：避免方法内部多次触发更新
                const isNotificationDisabled = dep._notificationDisabled;
                dep._notificationDisabled = true;
                const originalResult = Array.prototype[method].apply(this, args);
                
                try {
                    // 新增元素自动转为响应式（splice/push/unshift）
                    if (["splice", "push", "unshift"].includes(method)) {
                        const newItems = method === "splice" ? args.slice(2) : args;
                        newItems.forEach(item => (typeof item === "object" && item !== null && !item.__isReactive) && reactive(item));
                    }
                    
                    // 方法执行完成后，统一触发一次更新（减少通知次数）
                    dep._notificationDisabled = isNotificationDisabled;
                    if (!dep._notificationDisabled) dep.notify("array:mutate"); // 数组变更标记，便于精准订阅
                    
                    return originalResult;
                } catch (e) {
                    console.error(`[reactive] 数组方法 ${method} 执行失败:`, e);
                    dep._notificationDisabled = isNotificationDisabled;
                    return originalResult;
                }
            };
        });
        
        // 覆盖数组实例的原型（仅影响当前数组，不污染全局）
        Object.setPrototypeOf(arr, arrayProxyProto);
    };
    
    // 数组类型特殊处理
    if (Array.isArray(rawTarget)) {
        optimizeArray(rawTarget);
        // 数组元素初始化：已存在的嵌套对象转为响应式
        rawTarget.forEach((item, index) => (typeof item === "object" && item !== null && !item.__isReactive) && (rawTarget[index] = reactive(item)));
    }
    
    const proxy = new Proxy(rawTarget, {
        get(targetObj, prop, receiver) {
            // 内置属性直接返回（避免拦截__proto__、__isReactive等）
            if (prop === "__proto__" || prop === "__isReactive" || prop === "__raw" || prop === "__isReactiveProxy") return Reflect.get(targetObj, prop, receiver);
            
            if (_activeFns.length > 0) {
                const activeFn = _activeFns[_activeFns.length - 1];
                // 数组索引：标记为 index:0、index:1 等，支持精准更新
                if (Array.isArray(targetObj) && /^\d+$/.test(prop)) dep.subscribe(activeFn, `index:${prop}`);
                else dep.subscribe(activeFn, prop); // 普通属性：按属性名订阅
            }
            
            // 获取原始值
            const value = Reflect.get(targetObj, prop, receiver);
            
            // 避免初始化时递归代理所有嵌套对象，提升性能
            if (typeof value === "object" && value !== null && !value.__isReactive) return reactive(value);
            return value;
        },
        
        set(targetObj, prop, value, receiver) {
            // 禁止修改内置标记
            if (prop === "__isReactive" || prop === "__raw" || prop === "__isReactiveProxy") {
                console.warn(`[reactive] 禁止修改内置属性: ${prop}`);
                return true;
            }
            
            const oldValue = Reflect.get(targetObj, prop, receiver);
            
            // 新旧值严格相等
            if (oldValue === value || (Number.isNaN(oldValue) && Number.isNaN(value))) return true;
            
            // 数组长度修改：避免与数组方法重复触发（如push已修改length）
            if (Array.isArray(targetObj) && prop === "length" && typeof value === "number") {
                const oldLength = targetObj.length;
                if (value === oldLength) return true;
                // 长度缩小：删除的索引对应的依赖需要通知
                if (value < oldLength) {
                    for (let i = value; i < oldLength; i++) dep.notify(`index:${i}`);
                }
            }
            
            // 新值响应式处理
            const reactiveValue = typeof value === "object" && value !== null ? reactive(value) : value;
            const setResult = Reflect.set(targetObj, prop, reactiveValue, receiver);
            
            // 精准通知依赖
            if (!dep._notificationDisabled) {
                if (Array.isArray(targetObj) && /^\d+$/.test(prop)) dep.notify(`index:${prop}`); // 数组索引更新
                else dep.notify(prop); // 普通属性更新
            }
            
            return setResult;
        },
        
        deleteProperty(targetObj, prop) {
            // 禁止删除内置标记
            if (prop === "__isReactive" || prop === "__raw" || prop === "__isReactiveProxy") {
                console.warn(`[reactive] 禁止删除内置属性: ${prop}`);
                return false;
            }
            
            const hadProp = Reflect.has(targetObj, prop);
            const deleteResult = Reflect.deleteProperty(targetObj, prop);
            
            // 仅在属性存在且删除成功时通知
            if (hadProp && deleteResult && !dep._notificationDisabled) {
                if (Array.isArray(targetObj) && /^\d+$/.test(prop)) dep.notify(`index:${prop}`); // 数组索引删除
                else dep.notify(prop); // 普通属性删除
            }
            
            return deleteResult;
        }
    });
    
    // 标记当前是代理对象（不可枚举）
    Object.defineProperty(proxy, "__isReactiveProxy", { value: true, enumerable: false, configurable: false });
    dep.__proxy = proxy; // 原始对象存储代理引用（便于重复代理检测时直接返回）
    
    // 返回代理对象
    return proxy;
};


/**
 * 提供数据到根作用域 (为r-model提供的注入方法)
 * @param {{age: {value, __isRef: boolean}, name: {value, __isRef: boolean}}} key - 数据在作用域中的名称
 * @param {*} value - 要提供的数据（通常是 ref 或 reactive 对象）
 */
window.provide = (key, value = null) => {
    if (typeof key !== "object") _pendingProviders.push([key, value]); else for (const [k, v] of Object.entries(key)) _pendingProviders.push([k, v]);
};


/**
 * 组件定义函数
 * @param {string} compName - 组件名称 (唯一标识)
 * @param {Object} options - 组件配置对象
 * @param {string} options.template - 组件HTML模板
 * @param {string} options.style - 组件CSS样式
 * @param {Function} options.script - 组件脚本逻辑 (api, utils) => ({ ... })
 * @param {Object} [options.props] - 组件接收的属性定义
 * @param {string|HTMLElement} [options.mountTo] - 可选，组件定义后立即挂载到目标元素
 * @returns {Function|Object} 如果提供了 mountTo，则返回组件实例；否则返回一个渲染函数
 */
window.dom = (compName, options) => {
    if (typeof compName !== "string" || !options || typeof options !== "object") throw new Error("dom() 需传入组件名称和配置对象");
    const { template, style, script, props: propDefinitions, mountTo, styleIsolation = true, registerAs } = options;
    if (!template) console.warn(`组件 "${compName}" 缺少 template`);
    if (!window.__componentResetCache) window.__componentResetCache = new Set();
    
    // 生成唯一的组件ID
    const compId = `comp-${compName}-${Math.random().toString(36).substring(2, 9)}`;
    
    // 缓存模板处理结果
    let templateFragment;
    if (!_componentTemplates.has(compName)) {
        templateFragment = document.createDocumentFragment();
        if (template) {
            const tempContainer = document.createElement("div");
            tempContainer.innerHTML = template.trim();
            while (tempContainer.firstChild) templateFragment.appendChild(tempContainer.firstChild);
        }
        _componentTemplates.set(compName, templateFragment);
    } else templateFragment = _componentTemplates.get(compName);
    
    // 样式处理
    let styleElement = null;
    const processStyle = (isolationEnabled = styleIsolation) => {
        if (styleElement) {
            styleElement.remove();
            styleElement = null;
        }
        
        if (style && typeof style === "string") {
            // 根据隔离状态决定是否添加作用域
            const processedStyle = isolationEnabled ? addStyleScopeReliable(style, compId) : style;
            styleElement = document.createElement("style");
            styleElement.setAttribute("data-comp", compName);
            styleElement.setAttribute("data-comp-id", compId);
            styleElement.textContent = processedStyle;
            document.head.appendChild(styleElement);
        }
        
        // 根据隔离状态决定是否添加重置样式
        if (isolationEnabled) addResetStyles(compId);
    };
    
    // 添加重置样式
    const addResetStyles = (scopeId) => {
        // 检查该组件是否已添加过重置样式
        if (window.__componentResetCache.has(compName)) return null; // 已添加过则直接返回
        window.__componentResetCache.add(compName); // 标记为已添加
        
        // moderate 级别的重置样式
        const resetStyles = `
            [data-${scopeId}] {box-sizing: border-box;}
            [data-${scopeId}] * {box-sizing: border-box;}
            [data-${scopeId}] div, [data-${scopeId}] article, [data-${scopeId}] section, [data-${scopeId}] header, [data-${scopeId}] footer, [data-${scopeId}] main, [data-${scopeId}] nav { display: block; }
            [data-${scopeId}] span, [data-${scopeId}] a, [data-${scopeId}] strong, [data-${scopeId}] em, [data-${scopeId}] i, [data-${scopeId}] b { display: inline; }
            [data-${scopeId}] p { display: block; margin: 1em 0; line-height: 1.5; }
            [data-${scopeId}] h1 { display: block; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
            [data-${scopeId}] h2 { display: block; font-size: 1.5em; font-weight: bold; margin: 0.83em 0; }
            [data-${scopeId}] h3 { display: block; font-size: 1.17em; font-weight: bold; margin: 1em 0; }
            [data-${scopeId}] h4 { display: block; font-weight: bold; margin: 1.33em 0; }
            [data-${scopeId}] h5 { display: block; font-size: 0.83em; font-weight: bold; margin: 1.67em 0; }
            [data-${scopeId}] h6 { display: block; font-size: 0.67em; font-weight: bold; margin: 2.33em 0; }
            [data-${scopeId}] button, [data-${scopeId}] input, [data-${scopeId}] select, [data-${scopeId}] textarea { display: inline-block; font-family: inherit; font-size: inherit; line-height: inherit; }
            [data-${scopeId}] ul, [data-${scopeId}] ol { display: block; list-style-position: outside; margin: 1em 0; padding-left: 40px; }
            [data-${scopeId}] li { display: list-item; }
            [data-${scopeId}] table { display: table; border-collapse: collapse; }
            [data-${scopeId}] tr { display: table-row; }
            [data-${scopeId}] td, [data-${scopeId}] th { display: table-cell; padding: 0.5em; border: 1px solid #ddd; }
            [data-${scopeId}] th { font-weight: bold; text-align: center; }
            [data-${scopeId}] img { display: inline-block; max-width: 100%; height: auto; }
            [data-${scopeId}] a { color: inherit; text-decoration: none; }
            [data-${scopeId}] a:hover { text-decoration: underline; }
            [data-${scopeId}] code { font-family: monospace; background: #f5f5f5; padding: 0.2em 0.4em; border-radius: 3px; }
            [data-${scopeId}] blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #ccc; font-style: italic; }
        `;
        
        // 创建样式元素
        const resetStyleElement = document.createElement("style");
        resetStyleElement.setAttribute("data-comp-reset", compName);
        resetStyleElement.setAttribute("data-scope-id", scopeId);
        resetStyleElement.setAttribute("data-reset-level", "moderate"); // 固定标记
        resetStyleElement.textContent = resetStyles;
        
        // 添加到文档头
        document.head.appendChild(resetStyleElement);
        
        // 缓存管理
        if (!window.__componentResetStyles) window.__componentResetStyles = new Map();
        window.__componentResetStyles.set(scopeId, resetStyleElement);
        return resetStyleElement;
    };
    
    // 清理重置样式
    const cleanupResetStyles = (compId) => {
        if (window.__componentResetStyles && window.__componentResetStyles.has(compId)) window.__componentResetStyles.delete(compId);
    };
    
    // CSS作用域实现
    const addStyleScopeReliable = (css, scopeId) => {
        // 先移除CSS注释（避免注释内的花括号干扰解析）
        const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/}}/g, "}").replace(/\s+/g, " ").trim();
        const result = []; // 用数组拼接替代字符串累加，提升性能
        let i = 0;
        const len = cleanCss.length;
        
        while (i < len) {
            if (cleanCss[i] === "@") {
                const atRuleEnd = findMatchingBrace(cleanCss, i);
                if (atRuleEnd === -1) break;
                const atRule = cleanCss.substring(i, atRuleEnd + 1);
                result.push(addStyleScopeToAtRule(atRule, scopeId));
                i = atRuleEnd + 1;
            } else {
                const ruleEnd = cleanCss.indexOf("}", i);
                if (ruleEnd === -1) break;
                const rule = cleanCss.substring(i, ruleEnd + 1);
                result.push(addStyleScopeToRule(rule, scopeId));
                i = ruleEnd + 1;
            }
        }
        
        return result.join(""); // 数组拼接比字符串+=更高效
    };
    
    // 找到匹配的大括号
    const findMatchingBrace = (css, start) => {
        let braceCount = 0;
        let inString = false;
        let stringChar = "";
        
        for (let i = start; i < css.length; i++) {
            const char = css[i];
            
            if ((char === "\"" || char === "'") && !inString) {
                inString = true;
                stringChar = char;
            } else if (char === stringChar && inString) inString = false;
            
            if (inString) continue;
            
            if (char === "{") braceCount++;
            else if (char === "}") {
                braceCount--;
                if (braceCount === 0) return i;
            }
        }
        return -1;
    };
    
    // 处理@规则
    const addStyleScopeToAtRule = (atRule, scopeId) => {
        const atRuleMatch = atRule.match(/^(@[^{]+)\{([^]*)}$/);
        if (!atRuleMatch) return atRule;
        const atRuleName = atRuleMatch[1].trim();
        const innerContent = atRuleMatch[2].trim();
        const scopedInnerContent = addStyleScopeReliable(innerContent, scopeId);
        return `${atRuleName} { ${scopedInnerContent} }`;
    };
    
    // 处理普通CSS规则
    const addStyleScopeToRule = (rule, scopeId) => {
        const ruleMatch = rule.match(/^([^{]+)\{([^}]*)}$/);
        if (!ruleMatch) return rule;
        
        let selectors = ruleMatch[1].trim();
        const declarations = ruleMatch[2].trim();
        if (!selectors || !declarations) return rule;
        
        const scopedSelectors = selectors
            .split(",")
            .map(selector => selector.trim())
            .filter(selector => selector)
            .map(selector => {
                if (selector === ":root" || selector === "html" || selector.startsWith("@")) return selector;
                return `${selector}[data-${scopeId}]`;
            })
            .join(", ");
        
        return `${scopedSelectors} { ${declarations} }`;
    };
    
    // DOM作用域添加函数
    const addComponentScopeToDOM = (element, isolationEnabled = styleIsolation) => {
        if (element.nodeType === Node.ELEMENT_NODE) {
            // 根据隔离状态决定是否添加作用域属性
            if (isolationEnabled) element.setAttribute(`data-${compId}`, "");
            if (element.children) Array.from(element.children).forEach(child => addComponentScopeToDOM(child, isolationEnabled));
        } else if (element.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            Array.from(element.children).forEach(child => addComponentScopeToDOM(child, isolationEnabled));
        }
    };
    
    // 工具函数
    const utils = Object.freeze({ ref: window.ref, reactive: window.reactive, provide: window.provide });
    const LIFECYCLE_HOOKS = ["mounted", "unmounted"];
    const NON_LIFECYCLE_METHODS = new Set(["setup", ...LIFECYCLE_HOOKS]);
    
    // 组件工厂函数
    const componentFactory = (props = {}, isolationOverride) => {
        const resolvedProps = Object.create(null);
        if (propDefinitions?.default) Object.assign(resolvedProps, propDefinitions.default);
        Object.assign(resolvedProps, props);
        
        // 优先使用挂载时的参数，其次使用组件定义时的默认值
        const finalIsolation = isolationOverride !== undefined ? isolationOverride : styleIsolation;
        
        const componentScope = reactive({
            $compName: compName,
            $compId: compId,
            $props: resolvedProps,
            $refs: Object.create(null),
            $styleIsolation: finalIsolation
        });
        
        let scriptResult = Object.create(null);
        if (typeof script === "function") {
            try {
                scriptResult = script({ $props: componentScope.$props, $refs: componentScope.$refs, $styleIsolation: finalIsolation }, utils) || {};
            } catch (e) {
                console.error(`[dom] 组件 "${compName}" 脚本执行错误:`, e);
            }
        }
        
        if (typeof scriptResult.setup === "function") {
            try {
                const setupResult = scriptResult.setup();
                if (setupResult && typeof setupResult === "object") Object.assign(componentScope, setupResult);
            } catch (e) {
                console.error(`[dom] 组件 "${compName}" setup 函数执行错误:`, e);
            }
        }
        
        const lifecycleHooks = Object.create(null);
        LIFECYCLE_HOOKS.forEach(hook => (typeof scriptResult[hook] === "function") && (lifecycleHooks[hook] = scriptResult[hook]));
        
        // 绑定方法到组件作用域
        Object.entries(scriptResult).forEach(([key, value]) => (typeof value === "function" && !NON_LIFECYCLE_METHODS.has(key)) && (componentScope[key] = value.bind(componentScope)));
        
        // 渲染函数 - 修改为接受样式隔离参数
        const render = (mountTargetEl, isolationOverride) => {
            if (!mountTargetEl?.nodeType || mountTargetEl.nodeType !== Node.ELEMENT_NODE) throw new Error(`组件 "${compName}" 挂载失败：无效的目标节点`);
            
            // 确定最终的样式隔离状态
            const finalIsolation = isolationOverride !== undefined ? isolationOverride : styleIsolation;
            const fragment = document.createDocumentFragment();
            
            // 处理样式，传入隔离状态
            processStyle(finalIsolation);
            
            // 克隆模板
            const templateClone = templateFragment.cloneNode(true);
            
            // 根据隔离状态决定是否添加作用域属性
            addComponentScopeToDOM(templateClone, finalIsolation);
            
            // 收集 refs
            const refElements = templateClone.querySelectorAll("[ref]");
            refElements.forEach(el => {
                const refName = el.getAttribute("ref");
                if (refName && !componentScope.$refs[refName]) componentScope.$refs[refName] = el;
            });
            
            // 处理模板中的指令和响应式数据
            _processElement(templateClone, componentScope);
            
            fragment.appendChild(templateClone);
            
            // 单次 DOM 操作
            mountTargetEl.textContent = "";
            mountTargetEl.appendChild(fragment);
            
            // 根据隔离状态决定是否添加容器标记
            if (finalIsolation) mountTargetEl.setAttribute(`data-${compId}-container`, "");
            if (lifecycleHooks.mounted) requestAnimationFrame(() => lifecycleHooks.mounted.call(componentScope));
            _componentInstances.set(mountTargetEl, componentScope);
            
            return {
                ...componentScope,
                getRootElement: () => mountTargetEl.querySelector(`[data-${compId}]`) || mountTargetEl.firstElementChild,
                unmount: () => {
                    if (lifecycleHooks.unmounted) lifecycleHooks.unmounted.call(componentScope);
                    mountTargetEl.textContent = "";
                    
                    // 清理重置样式
                    if (finalIsolation) cleanupResetStyles(compId);
                    _componentInstances.delete(mountTargetEl);
                }
            };
        };
        
        return { render };
    };
    
    // 挂载函数
    const mountComponent = (props, target, isolationOverride) => {
        const mountTarget = typeof target === "string" ? document.querySelector(target) : target;
        if (!mountTarget) {
            console.error(`组件 "${compName}" 挂载失败：找不到目标元素`);
            return null;
        }
        const { render } = componentFactory(props, isolationOverride);
        return render(mountTarget, isolationOverride);
    };
    
    // 自动注册逻辑
    const autoRegisterToRoot = () => {
        // 计算最终注册名
        const calculateRegisterName = () => {
            if (typeof registerAs === "string" && registerAs.trim()) return registerAs.trim();
            if (typeof compName === "string" && compName.trim()) return compName.trim();
            return `comp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; // 生成唯一组件名
        };
        
        // 创建组件工厂函数
        const createComponentFactory = (finalRegisterName, targetCompName) => {
            return (...args) => {
                let props = {};
                let target = null;
                let styleIsolation = undefined;
                
                // 参数解析逻辑
                if (args.length === 1 && typeof args[0] === "object") ({ props = {}, target, styleIsolation } = args[0]);
                else if (args.length >= 2) [props, target, styleIsolation] = args;
                else {
                    console.error(`组件 "${targetCompName}" 挂载失败：参数格式错误，期望对象或参数列表`);
                    return null;
                }
                
                if (!target) {
                    console.error(`组件 "${targetCompName}" 挂载失败：缺少target参数`);
                    return null;
                }
                
                return mountComponent(props, target, styleIsolation);
            };
        };
        
        // 注册组件到根作用域
        const registerToRootScope = (finalRegisterName, targetCompName) => {
            const tryRegister = () => {
                if (window.__rootScope) {
                    // 避免重复注册
                    if (window.__rootScope[finalRegisterName]) return void console.warn(`[dom] 组件名 "${finalRegisterName}" 已被占用，跳过注册`);
                    window.__rootScope[finalRegisterName] = createComponentFactory(finalRegisterName, targetCompName);
                } else setTimeout(tryRegister, 40); // 根作用域未就绪，延迟重试
            };
            
            // 根据文档状态决定注册时机
            if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tryRegister);
            else tryRegister();
        };
        
        // 执行注册流程
        const finalRegisterName = calculateRegisterName();
        registerToRootScope(finalRegisterName, compName);
    };
    
    // 执行自动注册
    autoRegisterToRoot();
    
    // 支持多种调用方式
    if (mountTo) return mountComponent({}, mountTo);  // 如果定义了 mountTo，立即挂载
    else {
        return (...args) => {
            if (args.length === 1 && typeof args[0] === "object") {
                // 对象形式：UserComponent({ props: {}, target: "#app", styleIsolation: false })
                const { props = {}, target, styleIsolation } = args[0];
                return mountComponent(props, target, styleIsolation);
            } else if (args.length >= 2) {
                // 参数形式：UserComponent(props, target, styleIsolation)
                const [props, target, styleIsolation] = args;
                return mountComponent(props, target, styleIsolation);
            } else {
                console.error(`组件 "${compName}" 挂载失败：参数格式错误`);
                return null;
            }
        };
    }
};


/**
 * 注册一个回调函数，该函数将在应用DOM完全加载和初始化后执行。
 * @param {Function} callback - 应用挂载后要执行的函数。
 */
window.onMounted = function (callback) {
    if (typeof callback === "function") _mountedCallbacks.push(callback);
    else console.warn("onMounted 只接受函数作为参数。");
};


/**
 * 应用初始化
 * 作用：启动应用，初始化响应式系统与DOM的关联
 */
document.addEventListener("DOMContentLoaded", () => {
    // 收集所有src为空的script标签内的代码
    document.querySelectorAll("script[src=\"\"]").forEach(scriptEl => {
        _inlineScripts.push(scriptEl.textContent.trim());
        scriptEl.remove(); // 移除原标签避免重复执行
    });
    
    // 初始化r-cp组件
    document.querySelectorAll("template[r-cp]").forEach(tplEl => {
        const compName = tplEl.getAttribute("r-cp").trim();
        if (!compName) return; // 组件名不能为空
        
        // 克隆模板内容（避免原模板被修改），存入全局注册表
        const templateFragment = document.createDocumentFragment();
        Array.from(tplEl.content.childNodes).forEach(node => templateFragment.appendChild(node.cloneNode(true)));
        _componentTemplates.set(compName, templateFragment);
        
        // 隐藏原template标签（避免渲染到页面）
        tplEl.style.display = "none";
    });
    
    // 获取应用根元素
    const AppEl = document.querySelector("[r-app]");
    const appRoot = AppEl || document.body; // 应用根元素，用于响应式处理
    
    // 创建根作用域
    const rootScope = reactive({});
    window.__rootScope = rootScope; // 暴露根作用域用于全局访问
    
    // 在处理DOM之前，先注入所有提供的数据
    _pendingProviders.forEach(([key, value]) => rootScope[key] = value);
    _pendingProviders.length = 0; // 清空队列，防止重复处理
    
    // 初始处理根元素
    _processElement(appRoot, rootScope);
    
    // 设置MutationObserver监听DOM变化
    const observer = new MutationObserver(mutations => {
        const toProcess = new Set(); // 指令处理集合
        
        mutations.forEach(mutation => {
            // 处理新增节点
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) toProcess.add(node);
                else if (node.nodeType === Node.TEXT_NODE && _INTERPOLATION_REGEX.test(node.textContent)) if (node.parentNode) toProcess.add(node.parentNode);
            });
            
            // 处理指令属性变更
            if (mutation.type === "attributes") {
                const target = mutation.target;
                if (_directives.has(mutation.attributeName)) toProcess.add(target);
            }
        });
        
        // 批量处理变化的元素
        _BatchUpdater.add(() => toProcess.forEach(el => _processElement(el, rootScope)));
    });
    
    // 开始观察DOM变化
    observer.observe(appRoot, { childList: true, subtree: true, attributes: true, attributeFilter: Array.from(_directives.keys()) });
    
    // 初始化路由
    _Router.init();
    
    // 执行所有挂载完成后的回调函数
    setTimeout(() => {
        // 执行空src的script标签内的代码
        _inlineScripts.forEach(scriptCode => {
            try {
                // 创建函数执行环境，继承全局作用域
                const scriptFn = new Function(scriptCode);
                scriptFn();
            } catch (error) {
                console.error("[Inline Script] 执行出错:", error);
            }
        });
        
        // 执行onMounted回调函数
        _mountedCallbacks.forEach(callback => {
            try {
                callback();
            } catch (error) {
                console.error("[onMounted] 回调函数执行出错:", error);
            }
        });
        
        // 清空数组里面的内容
        _mountedCallbacks.length = 0;
        _inlineScripts.length = 0;
    }, 0);
});
