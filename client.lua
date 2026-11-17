--[[
Forever Mod Studio: a stand-in for the WoW client's UI engine (forked from the
Forever HUD test space; see NOTES.md for what the fork added).

It runs UNMODIFIED addon files and turns their frames into a draw list the
page paints over a screenshot. It is not the game: art is approximated
(flat fills, placeholder icons), secret values and secure/combat rules are
not modelled, and unit data comes from the little simulation at the bottom.

Host (preview.js / smoke.cjs) provides:  HOST_measure(text, font, size) -> px
                                         HOST_log(text)   HOST_confirm(text) -> bool
                                         HOST_color(r, g, b) (opens a colour input)
Host calls:  PV_boot  PV_frame  PV_mouse  PV_wheel  PV_key  PV_cmd  PV_slash
Studio additions:  PV_begin  PV_saved  PV_file  PV_loaded  PV_start   (load any addon, file by file)
                   PV_serialize (SavedVariables -> Lua source)  PV_mods  PV_text  PV_eval  PV_rect
]]
local P = { frames = {}, timers = {}, chat = {}, watch = {}, now = 1000, W = 1920, H = 1080, rc = {}, sc = {},
    loaded = {}, shared = {}, sv = {}, meta = {}, btn = {}, downBy = {}, errSeen = {} }
PV = P
local unpack = unpack or table.unpack
_G.unpack = unpack
-- Lua 5.1 habits the addons rely on (the page runs them on a 5.3 VM)
do
    local fmt = string.format
    string.format = function(f, ...)
        local ok, res = pcall(fmt, f, ...)
        if ok then return res end
        local a, n = { ... }, select("#", ...)
        for i = 1, n do
            if type(a[i]) == "number" and a[i] ~= math.floor(a[i]) then a[i] = math.floor(a[i]) end
            if type(a[i]) == "number" and math.type and math.type(a[i]) == "float" and a[i] == math.floor(a[i]) then a[i] = math.floor(a[i]) end
        end
        ok, res = pcall(fmt, f, unpack(a, 1, n))
        if ok then return res end
        error(res, 2)
    end
    format = string.format
    strmatch, strfind, strsub, strlower, strupper, strlen, gsub = string.match, string.find, string.sub, string.lower, string.upper, string.len, string.gsub
    loadstring = loadstring or load
    math.pow = math.pow or function(a, b) return a ^ b end
    table.getn = table.getn or function(t) return #t end
end
local floor, max, min, ceil = math.floor, math.max, math.min, math.ceil

local Widget = {}
Widget.__index = Widget
local seq = 0
local STRATA = { BACKGROUND = 1, LOW = 2, MEDIUM = 3, HIGH = 4, DIALOG = 5, FULLSCREEN = 6, FULLSCREEN_DIALOG = 7, TOOLTIP = 8 }
local LAYER = { BACKGROUND = 1, BORDER = 2, ARTWORK = 3, OVERLAY = 4, HIGHLIGHT = 5 }
local FONTOBJ = {}

local function Dirty() P.rc = {}; P.sc = {} end

local function New(kind, name, parent)
    seq = seq + 1
    local w = setmetatable({
        __kind = kind, __name = name, __parent = parent, __shown = true, __scripts = {}, __text = "",
        __w = 0, __h = 0, __scale = 1, __alpha = 1, __points = {}, __children = {}, __regions = {},
        __seq = seq, __min = 0, __max = 1, __value = 0, __checked = false,
    }, Widget)
    if name then _G[name] = w end
    return w
end

local function IsRegion(w) return w.__kind == "Texture" or w.__kind == "FontString" end

local function Attach(w, parent)
    w.__parent = parent
    if not parent then return end
    if IsRegion(w) then
        parent.__regions[#parent.__regions + 1] = w
        parent.__rsorted = nil
    else
        parent.__children[#parent.__children + 1] = w
    end
end

local function Detach(w)
    local p = w.__parent
    if not p then return end
    local list = IsRegion(w) and p.__regions or p.__children
    for i = #list, 1, -1 do if list[i] == w then table.remove(list, i) end end
    p.__rsorted = nil
end

---------------------------------------------------------------- layout
local function Scale(w)
    local c = P.sc[w]
    if c then return c end
    local s, x = 1, w
    while x do s = s * (x.__scale or 1); x = x.__parent end
    P.sc[w] = s
    return s
end

local function Strip(t)
    t = tostring(t or "")
    if t:find("|", 1, true) then
        t = t:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""):gsub("|T.-|t", ""):gsub("|n", "\n")
    end
    return t
end

local function FontOf(fs)
    local f = fs.__font
    if f then return f[1], f[2], f[3] or "" end
    local o = fs.__fontobj and FONTOBJ[fs.__fontobj]
    if o then return o.path, o.size, "" end
    return STANDARD_TEXT_FONT, 12, ""
end

local mcache = {}
local function Measure(text, path, size)
    local key = path .. "\1" .. size .. "\1" .. text
    local v = mcache[key]
    if not v then
        v = HOST_measure(text, path, size)
        mcache[key] = v
    end
    return v
end
P.ClearMeasure = function() mcache = {}; Dirty() end

-- natural size of a font string in its own units
local function TextSize(fs)
    local path, size = FontOf(fs)
    local text = Strip(fs.__text)
    if text == "" then return 0, size * 1.15 end
    local widest, lines = 0, 0
    for line in (text .. "\n"):gmatch("(.-)\n") do
        local lw = Measure(line, path, size)
        lines = lines + 1
        if fs.__w > 0 and lw > fs.__w and fs.__wrap ~= false then lines = lines + ceil(lw / fs.__w) - 1 end
        if lw > widest then widest = lw end
    end
    return widest, lines * size * 1.18
end

local Rect

-- [studio] colour maths for the ColorSelect widget. h, s, v are all 0..1.
local function HSV2RGB(h, s, v)
    h = (h % 1) * 6
    local i = floor(h)
    local f = h - i
    local p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    if i == 0 then return v, t, p elseif i == 1 then return q, v, p elseif i == 2 then return p, v, t
    elseif i == 3 then return p, q, v elseif i == 4 then return t, p, v end
    return v, p, q
end
local function RGB2HSV(r, g, b)
    local mx, mn = max(r, g, b), min(r, g, b)
    local d = mx - mn
    local h = 0
    if d > 0 then
        if mx == r then h = ((g - b) / d) % 6 elseif mx == g then h = (b - r) / d + 2 else h = (r - g) / d + 4 end
        h = h / 6
    end
    return h % 1, (mx > 0) and d / mx or 0, mx
end
P.HSV2RGB, P.RGB2HSV = HSV2RGB, RGB2HSV

-- [studio] where a ColorSelect's two thumbs sit: on the wheel at (hue, saturation)
-- and on the brightness bar at value. Hue 0 is at the right, turning anticlockwise.
local function CSThumbRect(t, depth)
    local cs = t.__csOwner
    local hsv = cs and cs.__hsv
    if not hsv then return nil end
    local s = Scale(t)
    local w, h = t.__w * s, t.__h * s
    if t.__csThumb == "wheel" then
        local wr = cs.__csWheel and Rect(cs.__csWheel, depth)
        if not wr then return nil end
        local R = min(wr.w, wr.h) / 2
        local a = hsv[1] * 2 * math.pi
        local cx = wr.x + wr.w / 2 + math.cos(a) * hsv[2] * R
        local cy = wr.y + wr.h / 2 - math.sin(a) * hsv[2] * R
        return { x = cx - w / 2, y = cy - h / 2, w = w, h = h }
    end
    local vr = cs.__csValue and Rect(cs.__csValue, depth)
    if not vr then return nil end
    local cy = vr.y + (1 - hsv[3]) * vr.h
    return { x = vr.x + vr.w / 2 - w / 2, y = cy - h / 2, w = w, h = h }
end

local function BarFrac(bar)
    if bar.__timer then
        local t = bar.__timer
        local frac = t.dur:Fraction()
        if t.remaining then frac = 1 - frac end
        return frac
    end
    local lo, hi, v = bar.__min, bar.__max, bar.__value
    if type(v) ~= "number" or type(lo) ~= "number" or type(hi) ~= "number" or hi <= lo then return 0 end
    return max(0, min(1, (v - lo) / (hi - lo)))
end

local function BarFill(bar, pr)
    local frac = BarFrac(bar)
    if bar.__orientation == "VERTICAL" then
        local h = pr.h * frac
        return { x = pr.x, y = bar.__reverse and pr.y or (pr.y + pr.h - h), w = pr.w, h = h }
    end
    local w = pr.w * frac
    return { x = bar.__reverse and (pr.x + pr.w - w) or pr.x, y = pr.y, w = w, h = pr.h }
end

Rect = function(w, depth)
    local c = P.rc[w]
    if c ~= nil then return c or nil end
    depth = (depth or 0) + 1
    if depth > 60 or not w then return nil end
    local r
    if w == UIParent then
        r = { x = 0, y = 0, w = P.W, h = P.H }
    else
        local s = Scale(w)
        local parent = w.__parent
        if w.__isBarTex then
            local pr = Rect(parent, depth)
            if pr then r = BarFill(parent, pr) end
        elseif w.__csThumb then
            r = CSThumbRect(w, depth)
        elseif parent and parent.__scrollChild == w then
            local pr = Rect(parent, depth)
            if pr then r = { x = pr.x, y = pr.y - (parent.__vscroll or 0) * s, w = w.__w * s, h = w.__h * s } end
        elseif w.__allPoints then
            local tr = Rect(w.__allPointsTo or parent or UIParent, depth)
            if tr then r = { x = tr.x, y = tr.y, w = tr.w, h = tr.h } end
        elseif #w.__points > 0 then
            local left, right, top, bottom, cx, cy
            for i = 1, #w.__points do
                local p = w.__points[i]
                local rel = p.rel
                if rel == nil then rel = parent or UIParent end
                if type(rel) == "string" then rel = _G[rel] end
                local rr = type(rel) == "table" and Rect(rel, depth)
                if not rr then P.rc[w] = false; return nil end
                local rp, pt = p.relPoint, p.point
                local ax = rr.x + ((rp:find("LEFT") and 0) or (rp:find("RIGHT") and rr.w) or rr.w / 2) + p.x * s
                local ay = rr.y + ((rp:find("TOP") and 0) or (rp:find("BOTTOM") and rr.h) or rr.h / 2) - p.y * s
                if pt:find("LEFT") then left = ax elseif pt:find("RIGHT") then right = ax else cx = ax end
                if pt:find("TOP") then top = ay elseif pt:find("BOTTOM") then bottom = ay else cy = ay end
            end
            local width, height = w.__w * s, w.__h * s
            if w.__kind == "FontString" then
                local tw, th = TextSize(w)
                if w.__w <= 0 then width = tw * s end
                if w.__h <= 0 then height = th * s end
            end
            if left and right then width = right - left end
            if top and bottom then height = bottom - top end
            r = {
                x = left or (right and right - width) or ((cx or 0) - width / 2),
                y = top or (bottom and bottom - height) or ((cy or 0) - height / 2),
                w = width, h = height,
            }
        end
    end
    P.rc[w] = r or false
    return r
end
P.Rect = Rect

local function Visible(w)
    while w do
        if not w.__shown then return false end
        w = w.__parent
    end
    return true
end

---------------------------------------------------------------- widget methods
local function Fire(w, script, ...)
    local fn = w.__scripts[script]
    if fn then return fn(w, ...) end
end

function Widget:GetName() return self.__name end
function Widget:GetObjectType() return self.__kind end
function Widget:IsObjectType(k) return self.__kind == k end
function Widget:RegisterEvent(ev) self.__events = self.__events or {}; self.__events[ev] = true end
function Widget:RegisterUnitEvent(ev, ...)
    self:RegisterEvent(ev)
    self.__unitEvents = self.__unitEvents or {}
    self.__unitEvents[ev] = { ... }
end
function Widget:UnregisterEvent(ev)
    if self.__events then self.__events[ev] = nil end
    if self.__unitEvents then self.__unitEvents[ev] = nil end
end
function Widget:UnregisterAllEvents() self.__events, self.__unitEvents = nil, nil end
function Widget:IsEventRegistered(ev) return self.__events and self.__events[ev] or false end

function Widget:SetSize(w, h) self.__w, self.__h = w or 0, h or w or 0; Dirty() end
function Widget:SetWidth(w) self.__w = w or 0; Dirty() end
function Widget:SetHeight(h) self.__h = h or 0; Dirty() end
local function Computed(self)
    return self.__allPoints or #self.__points >= 2 or (self.__kind == "FontString")
end
function Widget:GetWidth()
    if Computed(self) then
        local r = Rect(self)
        if r then return r.w / Scale(self) end
    end
    return self.__w
end
function Widget:GetHeight()
    if Computed(self) then
        local r = Rect(self)
        if r then return r.h / Scale(self) end
    end
    return self.__h
end
function Widget:GetSize() return self:GetWidth(), self:GetHeight() end
function Widget:GetStringWidth() return (TextSize(self)) end
function Widget:GetStringHeight() return select(2, TextSize(self)) end
function Widget:GetParent() return self.__parent end
function Widget:SetParent(p)
    if type(p) == "string" then p = _G[p] end
    Detach(self); Attach(self, p); Dirty()
end
function Widget:SetPoint(point, a, b, c, d)
    local n = select("#", point, a, b, c, d)
    local p = { point = point, relPoint = point, x = 0, y = 0 }
    if type(a) == "number" then
        p.x, p.y = a, b or 0
    elseif type(b) == "string" then
        p.rel, p.relPoint, p.x, p.y = a, b, c or 0, d or 0
    elseif a ~= nil or type(b) == "number" then
        p.rel, p.x, p.y = a, b or 0, c or 0
    end
    if a == nil and type(b) == "string" then p.rel = UIParent end   -- (point, nil, relPoint, x, y): the screen
    for i = 1, #self.__points do
        if self.__points[i].point == point then self.__points[i] = p; Dirty(); return end
    end
    self.__points[#self.__points + 1] = p
    self.__allPoints = nil
    Dirty()
end
function Widget:ClearAllPoints() self.__points = {}; self.__allPoints = nil; Dirty() end
function Widget:GetNumPoints() return #self.__points end
function Widget:GetPoint(i)
    local p = self.__points[i or 1]
    if not p then return nil end
    return p.point, p.rel or self.__parent, p.relPoint, p.x, p.y
end
function Widget:SetAllPoints(target)
    if type(target) == "string" then target = _G[target] end
    self.__allPoints = true
    self.__allPointsTo = (type(target) == "table") and target or nil
    self.__points = {}
    Dirty()
end
function Widget:SetScript(ev, fn)
    self.__scripts[ev] = fn
    if ev == "OnUpdate" then P.updaters[self] = fn and true or nil end
end
function Widget:GetScript(ev) return self.__scripts[ev] end
function Widget:HasScript() return true end
function Widget:HookScript(ev, fn)
    local old = self.__scripts[ev]
    if old then
        self:SetScript(ev, function(...) old(...); fn(...) end)
    else
        self:SetScript(ev, fn)
    end
end
function Widget:Show()
    if self.__shown then return end
    self.__shown = true
    if Visible(self) then Fire(self, "OnShow") end
end
function Widget:Hide()
    if not self.__shown then return end
    local was = Visible(self)
    self.__shown = false
    if was then Fire(self, "OnHide") end
end
function Widget:SetShown(v) if v then self:Show() else self:Hide() end end
function Widget:IsShown() return self.__shown end
function Widget:IsVisible() return Visible(self) end
function Widget:SetAlpha(a) self.__alpha = tonumber(a) or 1 end
function Widget:GetAlpha() return self.__alpha end
function Widget:SetAlphaFromBoolean(b, t, f) self.__alpha = b and (t or 1) or (f or 0) end
function Widget:SetScale(s) if type(s) == "number" and s > 0 then self.__scale = s; Dirty() end end
function Widget:GetScale() return self.__scale end
function Widget:GetEffectiveScale() return Scale(self) end
function Widget:GetCenter()
    local r = Rect(self)
    if not r then return nil end
    local s = Scale(self)
    return (r.x + r.w / 2) / s, (P.H - (r.y + r.h / 2)) / s
end
function Widget:GetLeft() local r = Rect(self); return r and r.x / Scale(self) end
function Widget:GetRight() local r = Rect(self); return r and (r.x + r.w) / Scale(self) end
function Widget:GetTop() local r = Rect(self); return r and (P.H - r.y) / Scale(self) end
function Widget:GetBottom() local r = Rect(self); return r and (P.H - r.y - r.h) / Scale(self) end
function Widget:GetRect()
    local r = Rect(self)
    if not r then return nil end
    local s = Scale(self)
    return r.x / s, (P.H - r.y - r.h) / s, r.w / s, r.h / s
end
function Widget:SetFrameStrata(s) self.__strata = STRATA[s] end
local STRATA_NAME = {}
for k, v in pairs(STRATA) do STRATA_NAME[v] = k end
function Widget:GetFrameStrata()   -- [studio] the real one: its own, or the nearest parent's
    local w = self
    while w do
        if w.__strata then return STRATA_NAME[w.__strata] or "MEDIUM" end
        w = w.__parent
    end
    return "MEDIUM"
end
function Widget:SetFrameLevel(l) self.__level = l end
function Widget:GetFrameLevel()
    local lvl, w = 0, self
    while w do
        if w.__level then return w.__level + lvl end
        lvl = lvl + 1
        w = w.__parent
    end
    return lvl
end
function Widget:SetToplevel() end
function Widget:Raise() seq = seq + 1; self.__seq = seq end
function Widget:EnableMouse(on) self.__mouse = on and true or false end
function Widget:IsMouseEnabled() return self.__mouse and true or false end
function Widget:EnableMouseWheel(on) self.__wheel = on and true or false end
function Widget:IsMouseWheelEnabled() return self.__wheel and true or false end
function Widget:EnableKeyboard() end
function Widget:SetMouseClickEnabled() end
function Widget:RegisterForDrag(...) self.__drag = select("#", ...) > 0 end
-- [studio] which buttons make OnClick fire. The client's default is the left button only.
function Widget:RegisterForClicks(...)
    local set = {}
    for i = 1, select("#", ...) do
        local c = tostring((select(i, ...)))
        if c:find("^Any") then set.LeftButton, set.RightButton, set.MiddleButton = true, true, true
        else
            local b = c:match("^(%a+Button)")
            if b then set[b] = true end
        end
    end
    self.__clicks = set
end
function Widget:SetMovable() end
function Widget:SetUserPlaced() end
function Widget:SetClampedToScreen() end
function Widget:SetClampRectInsets() end
function Widget:SetHitRectInsets() end
function Widget:SetResizable() end
function Widget:SetResizeBounds(a, b, c, d) self.__bounds = { a, b, c, d } end
function Widget:SetClipsChildren(on) self.__clips = on and true or false end
function Widget:SetAttribute(k, v) self.__attr = self.__attr or {}; self.__attr[k] = v end
function Widget:GetAttribute(k) return self.__attr and self.__attr[k] end
function Widget:SetID(i) self.__id = i end
function Widget:GetID() return self.__id or 0 end

local function Pin(f)   -- replace the anchors with a plain TOPLEFT one where the frame is now
    local r = Rect(f)
    if not r then return nil end
    local s = Scale(f)
    f.__points = { { point = "TOPLEFT", rel = UIParent, relPoint = "TOPLEFT", x = r.x / s, y = -r.y / s } }
    f.__allPoints = nil
    return r, s
end
function Widget:StartMoving()
    local r = Pin(self)
    if not r then return end
    P.moving = { f = self, mode = "move", dx = P.mx - r.x, dy = P.my - r.y }
end
function Widget:StartSizing()
    local r, s = Pin(self)
    if not r then return end
    self.__w, self.__h = r.w / s, r.h / s
    P.moving = { f = self, mode = "size", dx = r.x + r.w - P.mx, dy = r.y + r.h - P.my }
end
function Widget:StopMovingOrSizing()
    if P.moving and P.moving.f == self then P.moving = nil end
end
function Widget:IsMovable() return true end

function Widget:SetBackdrop(info) self.__backdrop = info end
function Widget:SetBackdropColor(r, g, b, a) self.__bdc = { r, g, b, a or 1 } end
function Widget:SetBackdropBorderColor(r, g, b, a) self.__bdb = { r, g, b, a or 1 } end
function Widget:GetBackdropColor() local c = self.__bdc or { 1, 1, 1, 1 }; return c[1], c[2], c[3], c[4] end
function Widget:GetBackdropBorderColor() local c = self.__bdb or { 1, 1, 1, 1 }; return c[1], c[2], c[3], c[4] end

-- status bars
function Widget:SetStatusBarTexture(t)
    if not self.__bartex then
        self.__bartex = New("Texture", nil, nil)
        self.__bartex.__isBarTex = true
        Attach(self.__bartex, self)
    end
    self.__bartex.__texture = t
end
function Widget:GetStatusBarTexture() return self.__bartex end
function Widget:SetStatusBarColor(r, g, b, a) self.__barColor = { r, g, b, a or 1 } end
function Widget:GetStatusBarColor() local c = self.__barColor or { 1, 1, 1, 1 }; return c[1], c[2], c[3], c[4] end
function Widget:SetMinMaxValues(a, b) self.__min, self.__max = a, b; self.__timer = nil; Dirty() end
function Widget:GetMinMaxValues() return self.__min, self.__max end
function Widget:SetReverseFill(on) self.__reverse = on and true or false; Dirty() end
function Widget:SetFillStyle() end
function Widget:SetRotatesTexture() end
function Widget:SetTimerDuration(dur, _, direction)
    if type(dur) ~= "table" then self.__timer = nil; return end
    self.__timer = { dur = dur, remaining = (direction == 1) }
    Dirty()
end
function Widget:GetTimerDuration() return self.__timer and self.__timer.dur end
function Widget:SetValue(v)
    if self.__kind == "Slider" then
        if type(v) ~= "number" then return end
        local step = self.__step
        if step and step > 0 then v = self.__min + floor((v - self.__min) / step + 0.5) * step end
        if v < self.__min then v = self.__min end
        if v > self.__max then v = self.__max end
        local changed = v ~= self.__value
        self.__value = v
        if changed then Fire(self, "OnValueChanged", v, P.userInput or false) end
        return
    end
    self.__value = v
    self.__timer = nil
    Dirty()
end
function Widget:GetValue() return self.__value end
function Widget:SetOrientation(o) self.__orientation = o; Dirty() end
function Widget:SetValueStep(s) self.__step = s end
function Widget:GetValueStep() return self.__step end
function Widget:SetObeyStepOnDrag() end
function Widget:SetStepsPerPage() end
function Widget:GetThumbTexture()
    if not self.__thumb then self.__thumb = New("Texture", nil, nil); self.__thumb.__parent = self end
    return self.__thumb
end
function Widget:SetThumbTexture() end

-- text
function Widget:SetText(t)
    if self.__kind == "Button" or self.__kind == "CheckButton" then
        local fs = self:GetFontString()
        fs.__text = tostring(t or "")
        Dirty()
        return
    end
    t = tostring(t or "")
    local changed = t ~= self.__text
    self.__text = t
    Dirty()
    if self.__kind == "EditBox" and changed then Fire(self, "OnTextChanged", false) end
end
function Widget:GetText()
    if self.__btnText then return self.__btnText.__text end
    return self.__text
end
function Widget:SetFormattedText(f, ...) self:SetText(string.format(f, ...)) end
function Widget:GetFontString()
    if not self.__btnText then
        local fs = New("FontString", nil, nil)
        Attach(fs, self)
        fs.__layer = LAYER.OVERLAY
        fs.__fontobj = self.__template == "UIPanelButtonTemplate" and "GameFontNormal" or "GameFontNormalSmall"
        fs.__points = { { point = "CENTER", relPoint = "CENTER", x = 0, y = 0 } }
        fs.__btnLabel = true
        self.__btnText = fs
    end
    return self.__btnText
end
function Widget:SetFontString(fs) self.__btnText = fs end
function Widget:SetNormalFontObject(o) self:GetFontString():SetFontObject(o) end
function Widget:SetHighlightFontObject() end
function Widget:SetDisabledFontObject() end
function Widget:SetFont(path, size, flags)
    local target = self.__btnText or self
    if type(path) ~= "string" or type(size) ~= "number" or size <= 0 then return false end
    target.__font = { path, size, flags or "" }
    Dirty()
    return true
end
function Widget:GetFont()
    local target = self.__btnText or self
    return FontOf(target)
end
function Widget:SetFontObject(o)
    local target = self.__btnText or self
    if type(o) == "table" then o = o.__fontobj end
    target.__fontobj = o
    target.__font = nil
    Dirty()
end
function Widget:GetFontObject() return self end
function Widget:SetTextColor(r, g, b, a) (self.__btnText or self).__textColor = { r, g, b, a or 1 } end
function Widget:GetTextColor() local c = self.__textColor or { 1, 1, 1, 1 }; return c[1], c[2], c[3], c[4] end
function Widget:SetShadowColor(r, g, b, a) self.__shadow = (a == nil or a > 0) end
function Widget:SetShadowOffset(x, y) if x == 0 and y == 0 then self.__shadow = false elseif self.__shadow == nil then self.__shadow = true end end
function Widget:SetWordWrap(on) self.__wrap = on and true or false end
function Widget:SetNonSpaceWrap() end
function Widget:SetMaxLines() end
function Widget:SetJustifyH(j) self.__jh = j end
function Widget:SetJustifyV(j) self.__jv = j end
function Widget:SetSpacing() end
function Widget:SetTextInsets() end
function Widget:SetAutoFocus() end
function Widget:SetMaxLetters(n) self.__maxLetters = n end
function Widget:SetNumeric(on) self.__numeric = on ~= false end
function Widget:SetMultiLine() end
function Widget:SetCursorPosition() end
function Widget:HighlightText() end
function Widget:GetNumber() return tonumber(self.__text) or 0 end
function Widget:SetNumber(n) self:SetText(tostring(n)) end
function Widget:ClearFocus()
    if P.focus == self then P.focus = nil; Fire(self, "OnEditFocusLost") end
end
function Widget:SetFocus()
    if P.focus == self then return end
    if P.focus then P.focus:ClearFocus() end
    P.focus = self
    Fire(self, "OnEditFocusGained")
end
function Widget:HasFocus() return P.focus == self end

-- buttons
-- [studio] ColorSelect: a hue / saturation wheel and a brightness bar. The addon
-- hands over four textures; the engine draws the wheel and the bar into the
-- first and third and moves the two thumbs (see CSThumbRect, DrawTexture, CSPick).
function Widget:SetColorWheelTexture(t) self.__csWheel = t; if t then t.__csRole, t.__csOwner = "wheel", self end; Dirty() end
function Widget:GetColorWheelTexture() return self.__csWheel end
function Widget:SetColorWheelThumbTexture(t) self.__csWheelThumb = t; if t then t.__csThumb, t.__csOwner = "wheel", self end; Dirty() end
function Widget:GetColorWheelThumbTexture() return self.__csWheelThumb end
function Widget:SetColorValueTexture(t) self.__csValue = t; if t then t.__csRole, t.__csOwner = "value", self end; Dirty() end
function Widget:GetColorValueTexture() return self.__csValue end
function Widget:SetColorValueThumbTexture(t) self.__csValueThumb = t; if t then t.__csThumb, t.__csOwner = "value", self end; Dirty() end
function Widget:GetColorValueThumbTexture() return self.__csValueThumb end
function Widget:SetColorAlphaTexture() end
function Widget:SetColorAlphaThumbTexture() end
function Widget:SetColorRGB(r, g, b)
    r, g, b = max(0, min(1, tonumber(r) or 0)), max(0, min(1, tonumber(g) or 0)), max(0, min(1, tonumber(b) or 0))
    local old = self.__hsv or { 0, 0, 1 }
    local h, s, v = RGB2HSV(r, g, b)
    if s == 0 or v == 0 then h = old[1] end      -- grey has no hue of its own: keep the thumb where it was
    if v == 0 then s = old[2] end
    self.__hsv = { h, s, v }
    Dirty()
    local fn = self.__scripts.OnColorSelect
    if fn then fn(self, r, g, b) end
end
function Widget:GetColorRGB()
    local c = self.__hsv or { 0, 0, 1 }
    return HSV2RGB(c[1], c[2], c[3])
end
function Widget:SetColorHSV(h, s, v)   -- hue in degrees, as the client has it
    self.__hsv = { ((tonumber(h) or 0) % 360) / 360, max(0, min(1, tonumber(s) or 0)), max(0, min(1, tonumber(v) or 0)) }
    Dirty()
    local fn = self.__scripts.OnColorSelect
    if fn then fn(self, self:GetColorRGB()) end
end
function Widget:GetColorHSV()
    local c = self.__hsv or { 0, 0, 1 }
    return c[1] * 360, c[2], c[3]
end

function Widget:SetChecked(v) self.__checked = v and true or false end
function Widget:GetChecked() return self.__checked end
function Widget:Enable() self.__disabled = false end
function Widget:Disable() self.__disabled = true end
function Widget:SetEnabled(on) self.__disabled = not on end
function Widget:IsEnabled() return not self.__disabled end
function Widget:Click(button) if not self.__disabled then Fire(self, "OnClick", button or "LeftButton", false) end end
-- [studio] a button's state textures become real regions when the studio can
-- draw them (a file in an addon folder, an icon); other client art stays unseen
-- as before, so a button never turns into a grey block.
local function StateTexture(self, slot, t, layer)
    self[slot] = t
    local reg = self[slot .. "Reg"]
    local drawable = type(t) == "number" or (type(t) == "string"
        and (t:lower():find("^interface[\\/]addons[\\/]") or t:lower():find("^interface[\\/]icons[\\/]") or t:lower():find("sizegrabber", 1, true)))
    if type(t) == "table" and t.__kind == "Texture" then reg = t; self[slot .. "Reg"] = t; drawable = false end
    if drawable then
        if not reg then
            reg = self:CreateTexture(nil, layer)
            reg:SetAllPoints(self)
            self[slot .. "Reg"] = reg
        end
        reg:SetTexture(t)
        reg.__shown = true
    elseif reg and type(t) ~= "table" then
        reg.__shown = false
    end
end
function Widget:SetNormalTexture(t) StateTexture(self, "__normalTex", t, "ARTWORK") end
function Widget:SetHighlightTexture(t) StateTexture(self, "__highlightTex", t, "HIGHLIGHT") end
function Widget:SetPushedTexture(t) self.__pushedTex = t end
function Widget:SetDisabledTexture() end
function Widget:GetNormalTexture() return self.__normalTexReg end
function Widget:GetHighlightTexture() return self.__highlightTexReg end
function Widget:GetPushedTexture() return nil end
function Widget:LockHighlight() self.__locked = true end
function Widget:UnlockHighlight() self.__locked = false end
function Widget:SetButtonState() end

-- textures
function Widget:SetTexture(t, ...)
    self.__texture = t
    self.__solid = nil
    self.__portrait = nil
end
function Widget:GetTexture() return self.__texture end
function Widget:SetColorTexture(r, g, b, a) self.__solid = { r, g, b, a or 1 }; self.__texture = "solid" end
function Widget:SetAtlas(a) self.__texture = "atlas:" .. tostring(a) end
function Widget:SetVertexColor(r, g, b, a) self.__color = { r, g, b, a or 1 } end
function Widget:GetVertexColor() local c = self.__color or { 1, 1, 1, 1 }; return c[1], c[2], c[3], c[4] end
function Widget:SetDesaturated(on) self.__desat = on and true or false end
function Widget:IsDesaturated() return self.__desat and true or false end
function Widget:SetDesaturation(v) self.__desat = (tonumber(v) or 0) > 0.5 end
-- [studio] (left, right, top, bottom), or the eight-number corner form, of which
-- the studio keeps the surrounding box: UL, LL, UR, LR as x, y pairs
function Widget:SetTexCoord(a, b, c, d, e, f, g, h)
    if h ~= nil then
        self.__tc = { min(a, c, e, g), max(a, c, e, g), min(b, d, f, h), max(b, d, f, h) }
    else
        self.__tc = { a, b, c, d }
    end
end
function Widget:GetTexCoord()
    local t = self.__tc or { 0, 1, 0, 1 }
    return t[1], t[3], t[1], t[4], t[2], t[3], t[2], t[4]
end
function Widget:SetBlendMode(m) self.__blend = m end
function Widget:SetDrawLayer(layer, sub)
    self.__layer = LAYER[layer] or 3
    self.__sub = sub or 0
    if self.__parent then self.__parent.__rsorted = nil end
end
function Widget:SetGradient() end
function Widget:SetMask() end
function Widget:SetMaskTexture(t) self.__mask = t end
-- [studio] radians, anticlockwise, about the centre: the page really turns the picture
function Widget:SetRotation(rad) self.__rot = tonumber(rad) or 0 end
function Widget:GetRotation() return self.__rot or 0 end
function Widget:SetSnapToPixelGrid() end
function Widget:SetTexelSnappingBias() end
function Widget:SetHorizTile() end
function Widget:SetVertTile() end

-- cooldowns
function Widget:SetCooldown(s, d)
    if type(s) == "number" and type(d) == "number" and d > 0 then self.__cd = { s, d } else self.__cd = nil end
end
function Widget:SetCooldownFromDurationObject(d)
    if type(d) == "table" and d.start then self.__cd = { d.start, d.duration } else self.__cd = nil end
end
function Widget:Clear() self.__cd = nil end
function Widget:SetDrawEdge() end
function Widget:SetDrawBling() end
function Widget:SetDrawSwipe() end
function Widget:SetReverse(on) self.__cdReverse = on and true or false end
function Widget:SetHideCountdownNumbers() end
function Widget:SetSwipeColor() end
function Widget:SetSwipeTexture() end
function Widget:SetUseCircularEdge() end

-- scroll frames
local function ScrollRange(sf)
    local child = sf.__scrollChild
    local r = Rect(sf)
    if not child or not r then return 0 end
    return max(0, child.__h - r.h / Scale(sf))
end
function Widget:SetScrollChild(c)
    self.__scrollChild = c
    if c.__parent ~= self then Detach(c); Attach(c, self) end
    Dirty()
end
function Widget:GetScrollChild() return self.__scrollChild end
function Widget:SetVerticalScroll(v)
    v = max(0, min(tonumber(v) or 0, ScrollRange(self)))
    self.__vscroll = v
    Dirty()
end
function Widget:GetVerticalScroll() return self.__vscroll or 0 end
function Widget:GetVerticalScrollRange() return ScrollRange(self) end
function Widget:SetHorizontalScroll() end
function Widget:GetHorizontalScroll() return 0 end
function Widget:UpdateScrollChildRect() end

-- models, tooltips, minimap
function Widget:SetUnit(u) self.__unit = u end
function Widget:SetPortraitZoom() end
function Widget:SetCamDistanceScale() end
function Widget:SetPosition() end
function Widget:ClearModel() self.__unit = nil end
function Widget:SetCamera() end
function Widget:GetZoom() return self.__zoom or 0 end
function Widget:SetZoom(z) self.__zoom = z end
function Widget:GetZoomLevels() return 6 end

function Widget:CreateTexture(name, layer, _, sub)
    local t = New("Texture", name, nil)
    t.__layer = LAYER[layer] or 3
    t.__sub = sub or 0
    Attach(t, self)
    return t
end
function Widget:CreateFontString(name, layer, fontobj)
    local t = New("FontString", name, nil)
    t.__layer = LAYER[layer] or 3
    t.__sub = 0
    if type(fontobj) == "table" then fontobj = fontobj.__fontobj end
    t.__fontobj = fontobj
    Attach(t, self)
    return t
end
function Widget:CreateMaskTexture() return New("Texture", nil, nil) end
function Widget:CreateAnimationGroup()
    local g = New("AnimationGroup", nil, nil)
    g.__parent = self
    return g
end
function Widget:CreateAnimation() return New("Animation", nil, nil) end
function Widget:Play() end
function Widget:Stop() end
function Widget:IsPlaying() return false end
function Widget:SetLooping() end
function Widget:SetDuration() end
function Widget:SetFromAlpha() end
function Widget:SetToAlpha() end
function Widget:SetOrder() end
function Widget:SetSmoothing() end

-- [studio] more of the widget API that addons other than the HUDs call. Simple
-- answers or no-ops: enough to let a file load, not a model of the client.
function Widget:GetChildren() return unpack(self.__children) end
function Widget:GetNumChildren() return #self.__children end
function Widget:GetRegions() return unpack(self.__regions) end
function Widget:GetNumRegions() return #self.__regions end
function Widget:IsMouseOver()
    local r = Rect(self)
    return (r and P.mx >= r.x and P.mx < r.x + r.w and P.my >= r.y and P.my < r.y + r.h) and true or false
end
function Widget:GetEffectiveAlpha()
    local a, w = 1, self
    while w do a = a * (w.__alpha or 1); w = w.__parent end
    return a
end
function Widget:IsForbidden() return false end
function Widget:IsProtected() return false, false end
function Widget:SetIgnoreParentAlpha() end
function Widget:SetIgnoreParentScale() end
function Widget:SetPropagateKeyboardInput() end
function Widget:SetFixedFrameStrata() end
function Widget:SetFixedFrameLevel() end
function Widget:SetFlattensRenderLayers() end
function Widget:SetDontSavePosition() end
function Widget:SetHyperlinksEnabled() end
function Widget:SetIndentedWordWrap() end
function Widget:SetTextScale() end
function Widget:GetNumLines() return 1 end
function Widget:IsTruncated() return false end
function Widget:GetUnboundedStringWidth() return self:GetStringWidth() end
function Widget:GetWrappedWidth() return self:GetStringWidth() end
function Widget:GetLineHeight() local _, size = self:GetFont(); return size or 12 end
function Widget:Insert(t) if self.__kind == "EditBox" then self:SetText(self.__text .. tostring(t or "")) end end
function Widget:GetNumLetters() return #self.__text end
function Widget:IsMultiLine() return false end
function Widget:SetBlinkSpeed() end
function Widget:SetAltArrowKeyMode() end
function Widget:AddMessage(m) if DEFAULT_CHAT_FRAME then DEFAULT_CHAT_FRAME:AddMessage(m) end end
function Widget:SetMinResize(a, b) self.__bounds = { a, b, (self.__bounds or {})[3], (self.__bounds or {})[4] } end
function Widget:SetMaxResize(a, b) self.__bounds = { (self.__bounds or {})[1], (self.__bounds or {})[2], a, b } end
function Widget:GetObjectTypeName() return self.__kind end
function Widget:SetStatusBarDesaturated() end
function Widget:SetSwipeDesaturated() end
function Widget:SetEdgeTexture() end
function Widget:SetBlingTexture() end
function Widget:SetCountdownFont() end
function Widget:SetCountdownAbbrevThreshold() end
function Widget:GetCooldownTimes() local c = self.__cd; if c then return c[1] * 1000, c[2] * 1000 end return 0, 0 end
function Widget:GetCooldownDuration() local c = self.__cd; return c and c[2] * 1000 or 0 end
function Widget:SetModel() end
function Widget:SetDisplayInfo() end
function Widget:SetFacing() end
function Widget:SetModelScale() end
function Widget:CreateLine()
    local t = New("Texture", nil, nil)   -- lines are not drawn
    t.__parent = self
    return t
end
function Widget:SetStartPoint() end
function Widget:SetEndPoint() end
function Widget:SetThickness() end
function Widget:SetColorTextureLine() end
function Widget:GetAnimationGroups() end
function Widget:SetToFinalAlpha() end
function Widget:Finish() end
function Widget:Pause() end
function Widget:SetChange() end
function Widget:SetOffset() end
function Widget:SetDegrees() end
function Widget:SetOrigin() end
function Widget:SetStartDelay() end
function Widget:SetEndDelay() end
function Widget:SetScaleFrom() end
function Widget:SetScaleTo() end
function Widget:SetChildKey() end
function Widget:SetTarget() end

---------------------------------------------------------------- templates
local function Template(w, template)
    for t in tostring(template):gmatch("[^,%s]+") do
        if t == "UICheckButtonTemplate" then
            w.__template = t
            w.__w, w.__h = 32, 32
            local fs = New("FontString", w.__name and (w.__name .. "Text") or nil, nil)
            Attach(fs, w)
            fs.__fontobj = "GameFontNormalSmall"
            fs.__points = { { point = "LEFT", rel = w, relPoint = "RIGHT", x = -2, y = 0 } }
            w.Text, w.text = fs, fs
        elseif t == "OptionsSliderTemplate" then
            w.__template = t
            w.__w, w.__h = 144, 17
            w.__orientation = "HORIZONTAL"
            local function label(suffix, obj, point, rel, x, y)
                local fs = New("FontString", w.__name and (w.__name .. suffix) or nil, nil)
                Attach(fs, w)
                fs.__fontobj = obj
                fs.__points = { { point = point, rel = w, relPoint = rel, x = x, y = y } }
                return fs
            end
            w.Text = label("Text", "GameFontHighlight", "BOTTOM", "TOP", 0, 0)
            w.Low = label("Low", "GameFontHighlightSmall", "TOPLEFT", "BOTTOMLEFT", 0, 3)
            w.High = label("High", "GameFontHighlightSmall", "TOPRIGHT", "BOTTOMRIGHT", 0, 3)
        elseif t == "UIPanelScrollFrameTemplate" then
            w.__template = t
            local sb = New("Slider", w.__name and (w.__name .. "ScrollBar") or nil, nil)
            Attach(sb, w)
            sb.__isScrollBar = true
            sb.__w = 16
            sb.__points = {
                { point = "TOPLEFT", rel = w, relPoint = "TOPRIGHT", x = 6, y = -16 },
                { point = "BOTTOMLEFT", rel = w, relPoint = "BOTTOMRIGHT", x = 6, y = 16 },
            }
            w.ScrollBar = sb
            P.frames[#P.frames + 1] = sb
        elseif t == "UIPanelCloseButton" then
            w.__template = t
            w.__w, w.__h = 32, 32
            w.__scripts.OnClick = function(self) if self.__parent then self.__parent:Hide() end end
        elseif t == "UIPanelButtonTemplate" or t == "InputBoxTemplate" then
            w.__template = t
            if t == "InputBoxTemplate" then w.__fontobj = "GameFontHighlightSmall" end
        elseif t == "PanelTabButtonTemplate" then
            w.__template = t
            w.__w, w.__h = 90, 28
            local fs = w:GetFontString()
            if w.__name then _G[w.__name .. "Text"] = fs end
            w.Text = fs
        end
    end
end

---------------------------------------------------------------- drawing
local out
local function Emit(...) out[#out + 1] = table.concat({ ... }, "\t") end
local function N(v) return string.format("%.2f", v or 0) end
local function Col(c, a, d)
    c = c or d or { 1, 1, 1, 1 }
    local r, g, b, al = c[1], c[2], c[3], c[4]
    if type(r) ~= "number" then r = 1 end
    if type(g) ~= "number" then g = 1 end
    if type(b) ~= "number" then b = 1 end
    if type(al) ~= "number" then al = 1 end
    return string.format("%.3f\t%.3f\t%.3f\t%.3f", r, g, b, al * a)
end
local function Box(r) return N(r.x) .. "\t" .. N(r.y) .. "\t" .. N(r.w) .. "\t" .. N(r.h) end

local function SpellLabel(tex)
    local w = tex.__parent
    while w do
        if w.__name then
            local key = w.__name:match("_Spell_(%w+)$")
            if key then return key end
        end
        w = w.__parent
    end
    return ""
end

local DEFAULT_TC = { 0, 1, 0, 1 }
local function F3(v) return string.format("%.3f", (type(v) == "number") and v or 1) end

local function DrawTextureBody(t, r, alpha)
    local tex = t.__texture
    local a = alpha * t.__alpha
    local add = (t.__blend == "ADD") and "1" or "0"
    local color = t.__color
    if t.__isBarTex and t.__parent.__barColor then color = t.__parent.__barColor end
    if t.__portrait then
        Emit("O", Box(r), a, t.__portrait.cls or "", t.__portrait.name or "?")
    elseif type(tex) == "number" then
        -- [studio] the vertex colour tints the placeholder icon (dark while on cooldown) and its alpha fades it
        local v = color or { 1, 1, 1, 1 }
        Emit("I", Box(r), a * ((type(v[4]) == "number") and v[4] or 1), tostring(tex), SpellLabel(t), t.__desat and "1" or "0", F3(v[1]), F3(v[2]), F3(v[3]))
    elseif type(tex) ~= "string" then
        return
    else
        local low = tex:lower()
        if t.__solid then
            local c = t.__solid
            local v = color or { 1, 1, 1, 1 }
            Emit("R", Box(r), Col({ c[1] * v[1], c[2] * v[2], c[3] * v[3], c[4] * (v[4] or 1) }, a), add, "0")
        elseif low:find("^interface[\\/]addons[\\/]") then
            -- [studio] a picture file from an addon folder: the page loads it (lazily) and
            -- draws the part SetTexCoord selects
            local tc = t.__tc or DEFAULT_TC
            Emit("P", Box(r), Col(color, a), add, t.__desat and "1" or "0",
                string.format("%.5f\t%.5f\t%.5f\t%.5f", tc[1] or 0, tc[2] or 1, tc[3] or 0, tc[4] or 1), (tex:gsub("[\t\r\n]", " ")))
        elseif low:find("^interface[\\/]icons[\\/]") then
            local v = color or { 1, 1, 1, 1 }
            Emit("I", Box(r), a * ((type(v[4]) == "number") and v[4] or 1), (tex:match("([^\\/]+)$") or tex), "", t.__desat and "1" or "0", F3(v[1]), F3(v[2]), F3(v[3]))
        elseif low:find("white8x8", 1, true) then
            Emit("R", Box(r), Col(color, a), add, "0")
        elseif low:find("statusbar", 1, true) or low:find("bar-hp-fill", 1, true) or low:find("raid-bar", 1, true) then
            Emit("R", Box(r), Col(color, a), add, "1")
        elseif low:find("spark", 1, true) then
            Emit("S", Box(r), Col(color, a))
        elseif low:find("sizegrabber", 1, true) then
            Emit("Z", Box(r), a)
        elseif low:find("raidtargetingicons", 1, true) then
            Emit("Y", Box(r), a, "raid", tostring(t.__raidIndex or 1))
        elseif low:find("stateicon", 1, true) then
            Emit("Y", Box(r), a, (t.__tc and t.__tc[1] and t.__tc[1] >= 0.4) and "combat" or "rest", "")
        elseif low:find("leadericon", 1, true) then
            Emit("Y", Box(r), a, "leader", "")
        elseif low:find("phasing", 1, true) then
            Emit("Y", Box(r), a, "phase", "")
        elseif low:find("icon-rez", 1, true) then
            Emit("Y", Box(r), a, "rez", "")
        elseif low:find("ui-pvp-", 1, true) then
            Emit("Y", Box(r), a, "pvp", low:find("alliance", 1, true) and "A" or "H")
        else
            Emit("R", Box(r), Col(color, a * 0.6), add, "0")
        end
    end
end

local function DrawTexture(t, r, alpha, hoverOnly)
    if r.w <= 0 or r.h <= 0 then return end
    local a = alpha * t.__alpha
    if a <= 0.004 then return end
    -- [studio] the two pictures of a ColorSelect are painted by the page
    if t.__csRole then
        if t.__csRole == "wheel" then
            Emit("W", Box(r), a)
        else
            local hsv = (t.__csOwner and t.__csOwner.__hsv) or { 0, 0, 1 }
            local cr, cg, cb = HSV2RGB(hsv[1], hsv[2], 1)
            Emit("G", Box(r), a, F3(cr), F3(cg), F3(cb))
        end
        return
    end
    local tex = t.__texture
    if tex == nil or tex == "" then return end
    -- [studio] SetRotation: everything this texture emits is turned about its centre.
    -- The client turns anticlockwise for a positive angle; the canvas turns clockwise.
    local rot = t.__rot
    if rot and rot ~= 0 then
        Emit("X", N(r.x + r.w / 2), N(r.y + r.h / 2), string.format("%.5f", -rot))
        DrawTextureBody(t, r, alpha)
        out[#out + 1] = "x"
    else
        DrawTextureBody(t, r, alpha)
    end
end

local function DrawText(fs, r, alpha, owner)
    local text = fs.__text
    if text == nil or text == "" then return end
    local a = alpha * fs.__alpha
    if a <= 0.004 then return end
    local path, size, flags = FontOf(fs)
    local c = fs.__textColor
    if not c then
        local o = fs.__fontobj and FONTOBJ[fs.__fontobj]
        c = o and o.color or { 1, 1, 1, 1 }
    end
    if fs.__btnLabel and owner then
        if owner.__disabled then c = { 0.5, 0.5, 0.5, 1 }
        elseif (P.hover == owner or owner.__selected) and not fs.__textColor then c = { 1, 1, 1, 1 } end
    end
    local s = Scale(fs)
    local jh = fs.__jh
    if not jh then
        jh = "CENTER"
        local p = fs.__points[1]
        if #fs.__points == 1 and p then
            if p.point:find("LEFT") then jh = "LEFT" elseif p.point:find("RIGHT") then jh = "RIGHT" end
        end
        if fs.__w > 0 and not fs.__btnLabel then jh = fs.__jh or "CENTER" end
    end
    Emit("T", Box(r), N(size * s), Col(c, a), jh, fs.__jv or "MIDDLE", flags or "",
        (fs.__shadow == false) and "0" or "1", (fs.__w > 0 and fs.__wrap ~= false) and "1" or "0",
        path, (text:gsub("[\t\r]", " "):gsub("\n", "\1")))
end

local function SortedRegions(f)
    local l = f.__rsorted
    if not l then
        l = {}
        for i, r in ipairs(f.__regions) do l[i] = r end
        table.sort(l, function(a, b)
            local la, lb = a.__layer or 3, b.__layer or 3
            if la ~= lb then return la < lb end
            local sa, sb = a.__sub or 0, b.__sub or 0
            if sa ~= sb then return sa < sb end
            local ta, tb = a.__kind == "FontString" and 1 or 0, b.__kind == "FontString" and 1 or 0
            if ta ~= tb then return ta < tb end
            return a.__seq < b.__seq
        end)
        f.__rsorted = l
    end
    return l
end

local function DrawFrame(f, r, alpha)
    local s = Scale(f)
    local hover = (P.hover == f) and "1" or "0"
    local bd = f.__backdrop
    if type(bd) == "table" and r then
        if bd.bgFile then Emit("R", Box(r), Col(f.__bdc, alpha), "0", "0") end
        if bd.edgeFile then
            local flat = tostring(bd.edgeFile):lower():find("white8x8", 1, true)
            Emit("B", Box(r), Col(f.__bdb, alpha), N(flat and max(1, (bd.edgeSize or 1) * s) or 1.5), flat and "0" or "1")
        end
    end
    local t = f.__template
    if r and t then
        if t == "UIPanelButtonTemplate" then
            Emit("U", Box(r), alpha, f.__disabled and "3" or ((P.down == f and P.hover == f) and "2" or hover))
        elseif t == "UICheckButtonTemplate" then
            Emit("H", Box(r), alpha, f.__checked and "1" or "0", hover, f.__disabled and "1" or "0")
        elseif t == "OptionsSliderTemplate" then
            local frac = (f.__max > f.__min) and (f.__value - f.__min) / (f.__max - f.__min) or 0
            Emit("L", Box(r), alpha, N(max(0, min(1, frac))), f.__disabled and "1" or "0")
        elseif t == "InputBoxTemplate" then
            Emit("E", Box(r), alpha, (P.focus == f) and "1" or "0")
        elseif t == "UIPanelCloseButton" then
            Emit("Q", Box(r), alpha, hover)
        elseif t == "PanelTabButtonTemplate" then
            Emit("A", Box(r), alpha, f.__selected and "1" or "0", hover)
        end
    end
    if r and f.__isScrollBar then
        local sf = f.__parent
        local range = ScrollRange(sf)
        if range > 0 then
            local view = r.h
            local total = view + range * s
            Emit("V", Box(r), alpha, N((sf.__vscroll or 0) / range), N(max(0.08, view / total)))
        end
    end
    if r and f.__isMinimap then
        Emit("M", Box(r), alpha, (f.__mask == 130937) and "square" or "round", tostring(f.__zoom or 0))
    end
    if r and f.__kind == "PlayerModel" and f.__unit and P.Unit(f.__unit) then
        local u = P.Unit(f.__unit)
        Emit("O", Box(r), alpha, u.class or "", u.name or "?")
    end
    for _, reg in ipairs(SortedRegions(f)) do
        if reg.__shown and (reg.__layer ~= LAYER.HIGHLIGHT or P.hover == f) then
            local rr = Rect(reg)
            if rr then
                if reg.__kind == "Texture" then DrawTexture(reg, rr, alpha) else DrawText(reg, rr, alpha, f) end
            end
        end
    end
    if r and f.__kind == "EditBox" then
        local path, size = FontOf(f)
        local c = f.__textColor or { 1, 1, 1, 1 }
        local caret = (P.focus == f and (P.now * 2) % 2 < 1) and "|" or ""
        Emit("T", N(r.x + 5 * s), N(r.y), N(r.w - 10 * s), N(r.h), N(size * s), Col(c, alpha), "LEFT", "MIDDLE", "",
            "1", "0", path, (f.__text .. caret))
    end
    if r and f.__kind == "Cooldown" and f.__cd then
        local left = f.__cd[1] + f.__cd[2] - P.now
        if left > 0 then Emit("C", Box(r), alpha, N(left / f.__cd[2])) else f.__cd = nil end
    end
end

local function Clip(a, b)
    if not a then return b end
    if not b then return a end
    local x, y = max(a.x, b.x), max(a.y, b.y)
    local x2, y2 = min(a.x + a.w, b.x + b.w), min(a.y + a.h, b.y + b.h)
    return { x = x, y = y, w = max(0, x2 - x), h = max(0, y2 - y) }
end

local function Collect(f, strata, level, alpha, clip, list)
    if not f.__shown then return end
    strata = f.__strata or strata
    level = f.__level or (level + 1)
    alpha = alpha * f.__alpha
    local r = Rect(f)
    list[#list + 1] = { f = f, key = strata * 1e9 + level * 1e5 + (f.__seq % 1e5), r = r, a = alpha, clip = clip }
    local cc = clip
    if (f.__kind == "ScrollFrame" or f.__clips) and r then cc = Clip(clip, r) end
    for _, c in ipairs(f.__children) do Collect(c, strata, level, alpha, cc, list) end
end

local function Tooltip()
    local tt = GameTooltip
    if not tt.__shown or #tt.lines == 0 then return end
    local k = UIParent.__scale
    local wmax, y = 0, 0
    for _, l in ipairs(tt.lines) do
        local w = Measure(Strip(l.text), STANDARD_TEXT_FONT, l.size)
        if w > wmax then wmax = w end
        y = y + l.size * 1.3
    end
    local W, Hh = (wmax + 16) * k, (y + 12) * k
    local x, yy = min(P.mx + 18, P.W - W - 4), max(4, min(P.my + 18, P.H - Hh - 4))
    out[#out + 1] = "K"
    Emit("R", N(x), N(yy), N(W), N(Hh), "0.050\t0.050\t0.080\t0.940", "0", "0")
    Emit("B", N(x), N(yy), N(W), N(Hh), "0.600\t0.600\t0.650\t1.000", "1.5", "1")
    local ly = yy + 6 * k
    for _, l in ipairs(tt.lines) do
        Emit("T", N(x + 8 * k), N(ly), N(wmax * k), N(l.size * 1.3 * k), N(l.size * k), Col({ l.r, l.g, l.b, 1 }, 1),
            "LEFT", "MIDDLE", "", "1", "0", STANDARD_TEXT_FONT, l.text)
        ly = ly + l.size * 1.3 * k
    end
end

local function Chat()
    local k = UIParent.__scale
    local y = P.H - 30 * k
    out[#out + 1] = "K"
    for i = #P.chat, max(1, #P.chat - 7), -1 do
        local m = P.chat[i]
        local age = P.now - m.t
        if age < 14 then
            local a = age > 11 and (14 - age) / 3 or 1
            Emit("T", N(24 * k), N(y - 16 * k), N(700 * k), N(16 * k), N(12 * k), Col({ 1, 0.95, 0.6, 1 }, a),
                "LEFT", "MIDDLE", "", "1", "0", STANDARD_TEXT_FONT, (Strip(m.text):gsub("[\t\n]", " ")))
            y = y - 16 * k
        end
    end
end

local function Draw()
    Dirty()
    local list = {}
    Collect(UIParent, STRATA.MEDIUM, 0, 1, nil, list)
    table.sort(list, function(a, b) return a.key < b.key end)
    P.order = list
    out = {}
    local cur
    for _, it in ipairs(list) do
        if it.a > 0.004 then
            if it.clip ~= cur then
                cur = it.clip
                out[#out + 1] = cur and ("K\t" .. Box(cur)) or "K"
            end
            DrawFrame(it.f, it.r, it.a)
        end
    end
    Chat()
    Tooltip()
    return table.concat(out, "\n")
end

---------------------------------------------------------------- events, timers
function P.Fire(event, ...)
    local unit = ...
    local snap = {}
    for i, f in ipairs(P.frames) do snap[i] = f end
    for _, f in ipairs(snap) do
        if f.__events and f.__events[event] and f.__scripts.OnEvent then
            local ok = true
            local ue = f.__unitEvents and f.__unitEvents[event]
            if ue then
                ok = false
                for _, u in ipairs(ue) do if u == unit then ok = true end end
            end
            if ok then
                P.Safe("event " .. event, f.__scripts.OnEvent, f, event, ...)
            end
        end
    end
end

-- [studio] Every call into addon code goes through Safe: an error is caught,
-- given its file and line, shown once in the log, and the app carries on.
-- When the error is raised inside the engine (a widget method the addon called
-- with something unexpected), the traceback supplies the addon line that called.
local function Trace(err)
    err = tostring(err)
    local tb = (debug and debug.traceback) and debug.traceback("", 2) or ""
    for line in tb:gmatch("[^\n]+") do
        local where = line:match("^%s*(.-%.lua:%d+):")
        if where and not where:find("client.lua", 1, true) then
            if not err:find(where, 1, true) then err = err .. "   [called from " .. where .. "]" end
            break
        end
    end
    return err
end
local function Report(what, err)
    local msg = "Lua error (" .. what .. "): " .. tostring(err)
    P.errCount = (P.errCount or 0) + 1
    local seen = P.errSeen[msg]
    P.errSeen[msg] = (seen or 0) + 1
    if not seen then HOST_log(msg) end   -- the same message again (an OnUpdate, say) is counted, not repeated
end
local function Safe(what, fn, ...)
    local ok, err = xpcall(fn, Trace, ...)
    if not ok then Report(what, err) end
    return ok
end
P.Safe, P.Report, P.Trace = Safe, Report, Trace

---------------------------------------------------------------- input
local function Interactive(f)
    if f.__mouse == false then return false end
    if f.__mouse then return true end
    local k = f.__kind
    if k == "Button" or k == "CheckButton" or k == "Slider" or k == "EditBox" or k == "ColorSelect" then return true end
    local s = f.__scripts
    return (s.OnMouseDown or s.OnMouseUp or s.OnEnter or s.OnDragStart or s.OnClick) and true or false
end

local function Inside(r, x, y) return r and x >= r.x and x < r.x + r.w and y >= r.y and y < r.y + r.h end

local function Hit(x, y, any)
    local list = P.order
    if not list then return nil end
    for i = #list, 1, -1 do
        local it = list[i]
        if it.a > 0.004 and Inside(it.r, x, y) and (not it.clip or Inside(it.clip, x, y)) and Visible(it.f)
            and it.f ~= UIParent and (any or Interactive(it.f)) then
            return it.f
        end
    end
end

local function SlideTo(sl, x, y)
    local r = Rect(sl)
    if not r then return end
    P.userInput = true
    if sl.__isScrollBar then
        local sf = sl.__parent
        sf:SetVerticalScroll(ScrollRange(sf) * max(0, min(1, (y - r.y) / max(1, r.h))))
    else
        local pad = 8 * Scale(sl)
        local frac = max(0, min(1, (x - r.x - pad) / max(1, r.w - 2 * pad)))
        Safe("slider", sl.SetValue, sl, sl.__min + (sl.__max - sl.__min) * frac)
    end
    P.userInput = false
end

-- [studio] ColorSelect picking: the mouse sets hue and saturation on the wheel,
-- brightness on the bar, and the widget tells its OnColorSelect script.
local function CSPart(cs, x, y)
    local wr = cs.__csWheel and Rect(cs.__csWheel)
    if wr then
        local R = min(wr.w, wr.h) / 2
        local dx, dy = x - (wr.x + wr.w / 2), y - (wr.y + wr.h / 2)
        if dx * dx + dy * dy <= (R + 3) * (R + 3) then return "wheel" end
    end
    local vr = cs.__csValue and Rect(cs.__csValue)
    if vr and x >= vr.x - 4 and x < vr.x + vr.w + 4 and y >= vr.y - 3 and y < vr.y + vr.h + 3 then return "value" end
    return nil
end
local function CSPick(cs, part, x, y)
    local hsv = cs.__hsv or { 0, 0, 1 }
    if part == "wheel" then
        local wr = Rect(cs.__csWheel)
        if not wr then return end
        local R = max(1, min(wr.w, wr.h) / 2)
        local dx, dy = x - (wr.x + wr.w / 2), (wr.y + wr.h / 2) - y
        local d = math.sqrt(dx * dx + dy * dy)
        local h = hsv[1]
        if d > 0.5 then h = ((math.atan2 or math.atan)(dy, dx) / (2 * math.pi)) % 1 end
        hsv = { h, min(1, d / R), hsv[3] }
    else
        local vr = Rect(cs.__csValue)
        if not vr then return end
        hsv = { hsv[1], hsv[2], 1 - max(0, min(1, (y - vr.y) / max(1, vr.h))) }
    end
    cs.__hsv = hsv
    Dirty()
    Safe("OnColorSelect", Fire, cs, "OnColorSelect", HSV2RGB(hsv[1], hsv[2], hsv[3]))
end

local BUTTONS = { [0] = "LeftButton", [1] = "MiddleButton", [2] = "RightButton", [3] = "Button4", [4] = "Button5" }
local function Clicks(f, btn)
    local set = f.__clicks
    if set then return set[btn] or false end
    return btn == "LeftButton"
end

-- [studio] Each mouse button is tracked on its own (P.btn, P.downBy), so a right
-- button hold (the HUDs' "turn") works alongside the left one, IsMouseButtonDown
-- answers truthfully, and OnMouseDown / OnMouseUp get the real button name.
function PV_mouse(kind, x, y, button, ctrl, shift)
    P.mx, P.my, P.ctrl, P.shift = x, y, ctrl, shift
    local btn = BUTTONS[button or 0] or "LeftButton"
    local left = (btn == "LeftButton")
    if kind == "move" then
        if P.moving then
            local m = P.moving
            local f, s = m.f, Scale(m.f)
            if m.mode == "move" then
                f.__points = { { point = "TOPLEFT", rel = UIParent, relPoint = "TOPLEFT", x = (x - m.dx) / s, y = -(y - m.dy) / s } }
            else
                local r = Rect(f)
                local b = f.__bounds or {}
                local nw = max(b[1] or 40, (x + m.dx - r.x) / s)
                local nh = max(b[2] or 40, (y + m.dy - r.y) / s)
                if b[3] and b[3] > 0 then nw = min(nw, b[3]) end
                if b[4] and b[4] > 0 then nh = min(nh, b[4]) end
                f.__w, f.__h = nw, nh
            end
            Dirty()
        elseif P.sliding then
            SlideTo(P.sliding, x, y)
        elseif P.csDrag then
            CSPick(P.csDrag.f, P.csDrag.part, x, y)
        elseif P.down and not P.dragging and P.down.__scripts.OnDragStart
            and (math.abs(x - P.downX) + math.abs(y - P.downY) > 4) then
            P.dragging = P.down
            Safe("OnDragStart", P.down.__scripts.OnDragStart, P.down, btn)
        end
        local h = (not P.moving and not P.dragging) and Hit(x, y) or P.hover
        if h ~= P.hover then
            if P.hover then Safe("OnLeave", Fire, P.hover, "OnLeave") end
            P.hover = h
            if h then Safe("OnEnter", Fire, h, "OnEnter") end
        end
    elseif kind == "down" then
        local h = Hit(x, y)
        P.btn[btn] = true
        P.downBy[btn] = h
        if left then P.down, P.downX, P.downY = h, x, y end
        if P.focus and P.focus ~= h then P.focus:ClearFocus() end
        if not h then return end
        if left then
            if h.__kind == "EditBox" then h:SetFocus() end
            if h.__kind == "Slider" and not h.__disabled then
                P.sliding = h
                SlideTo(h, x, y)
            end
            if h.__kind == "ColorSelect" then
                local part = CSPart(h, x, y)
                if part then
                    P.csDrag = { f = h, part = part }
                    CSPick(h, part, x, y)
                end
            end
        end
        Safe("OnMouseDown", Fire, h, "OnMouseDown", btn)
    elseif kind == "up" then
        local d = P.downBy[btn]
        P.btn[btn], P.downBy[btn] = nil, nil
        if left then
            P.down, P.sliding, P.csDrag = nil, nil, nil
            if P.dragging then
                local f = P.dragging
                P.dragging = nil
                Safe("OnDragStop", Fire, f, "OnDragStop")
                if P.moving then P.moving = nil end
                return
            end
        end
        if not d then
            if left then P.moving = nil end
            return
        end
        Safe("OnMouseUp", Fire, d, "OnMouseUp", btn, Hit(x, y) == d)
        if left and P.moving then P.moving = nil end
        if Hit(x, y) == d and (d.__kind == "Button" or d.__kind == "CheckButton") and not d.__disabled and Clicks(d, btn) then
            if d.__kind == "CheckButton" then d.__checked = not d.__checked end
            Safe("OnClick", Fire, d, "OnClick", btn, false)
        end
    end
end

-- [studio] modifier keys change without the mouse moving (CTRL pressed while
-- already hovering an item): the page reports them on every key event too
function PV_mods(ctrl, shift, alt)
    local was = P.ctrl
    P.ctrl, P.shift, P.alt = ctrl, shift, alt
    if was ~= ctrl then
        Safe("MODIFIER_STATE_CHANGED", P.Fire, "MODIFIER_STATE_CHANGED", "LCTRL", ctrl and 1 or 0)
    end
end

function PV_wheel(x, y, delta, ctrl, shift)
    P.mx, P.my = x, y
    if ctrl ~= nil then P.ctrl, P.shift = ctrl, shift end
    local f = Hit(x, y, true)
    while f do
        if f.__scripts.OnMouseWheel and f.__wheel ~= false then
            Safe("OnMouseWheel", f.__scripts.OnMouseWheel, f, delta)
            return true
        end
        if f.__kind == "ScrollFrame" and f.__template then
            f:SetVerticalScroll((f.__vscroll or 0) - delta * 40)
            return true
        end
        f = f.__parent
    end
    return false
end

-- returns true when the key was used
function PV_key(key, char)
    local e = P.focus
    if e then
        if key == "Enter" then Safe("OnEnterPressed", Fire, e, "OnEnterPressed")
        elseif key == "Escape" then
            if e.__scripts.OnEscapePressed then Safe("OnEscapePressed", Fire, e, "OnEscapePressed") else e:ClearFocus() end
        elseif key == "Tab" then
            Safe("OnTabPressed", Fire, e, "OnTabPressed")
        elseif key == "Backspace" then
            -- [studio] one whole character: step back over UTF-8 continuation bytes
            local t = e.__text
            local n = #t
            while n > 1 and t:byte(n) >= 128 and t:byte(n) < 192 do n = n - 1 end
            e.__text = t:sub(1, n - 1)
            Dirty()
            Safe("OnTextChanged", Fire, e, "OnTextChanged", true)
        elseif key == "Delete" then
            if e.__text ~= "" then
                e.__text = ""
                Dirty()
                Safe("OnTextChanged", Fire, e, "OnTextChanged", true)
            end
        elseif char and char ~= "" and not char:find("[%c]") then
            if (not e.__maxLetters or e.__maxLetters == 0 or #e.__text < e.__maxLetters)
                and (not e.__numeric or char:match("^%d$")) then
                e.__text = e.__text .. char
                Dirty()
                Safe("OnChar", Fire, e, "OnChar", char)
                Safe("OnTextChanged", Fire, e, "OnTextChanged", true)
            end
        end
        return true
    end
    if key == "Escape" then
        for i = #UISpecialFrames, 1, -1 do
            local f = _G[UISpecialFrames[i]]
            if f and f.__shown then f:Hide(); return true end
        end
    end
    return false
end

-- [studio] pasted text goes into the focused edit box one character at a time,
-- so the box's length limit and numeric rule still apply
function PV_text(text)
    if not P.focus then return false end
    for ch in tostring(text or ""):gmatch("[\1-\127\194-\244][\128-\191]*") do
        if ch ~= "\n" and ch ~= "\r" then PV_key("", ch) end
    end
    return true
end

---------------------------------------------------------------- [studio] general API
-- What addons other than the HUDs expect to find. These are honest, small
-- answers (an enUS level-60 character, no group, no guild) or no-ops; anything
-- not here raises a normal Lua error that the log shows with file and line.
function P.StudioGlobals()
    strsplit = function(sep, text, limit)
        text = tostring(text or "")
        local parts, from = {}, 1
        local set = "[" .. tostring(sep):gsub("[%]%^%-%%]", "%%%0") .. "]"
        while true do
            if limit and #parts + 1 >= limit then break end
            local a = text:find(set, from)
            if not a then break end
            parts[#parts + 1] = text:sub(from, a - 1)
            from = a + 1
        end
        parts[#parts + 1] = text:sub(from)
        return unpack(parts)
    end
    strjoin = function(sep, ...)
        local t = {}
        for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
        return table.concat(t, sep)
    end
    strtrim = function(s, chars)
        s = tostring(s or "")
        if chars then
            local set = "[" .. chars:gsub("[%]%^%-%%]", "%%%0") .. "]*"
            return (s:gsub("^" .. set, ""):gsub(set .. "$", ""))
        end
        return (s:gsub("^%s+", ""):gsub("%s+$", ""))
    end
    strrep, strbyte, strchar, strrev, strconcat = string.rep, string.byte, string.char, string.reverse, function(...) return table.concat({ ... }) end
    string.split, string.join, string.trim = strsplit, strjoin, strtrim
    tostringall = function(...)
        local t = {}
        for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
        return unpack(t, 1, select("#", ...))
    end
    sort, getn, foreach = table.sort, function(t) return #t end, function(t, f) for k, v in pairs(t) do f(k, v) end end
    -- (floor, max, min and ceil are locals of this file, hence the _G.)
    _G.abs, _G.ceil, _G.floor, _G.max, _G.min, _G.mod, _G.random, _G.sqrt = math.abs, math.ceil, math.floor, math.max, math.min, math.fmod, math.random, math.sqrt
    cos, sin, tan = function(d) return math.cos(math.rad(d)) end, function(d) return math.sin(math.rad(d)) end, function(d) return math.tan(math.rad(d)) end
    math.atan2 = math.atan2 or math.atan
    math.fmod = math.fmod or function(a, b) return a - b * ((a / b >= 0) and math.floor(a / b) or math.ceil(a / b)) end
    -- Lua 5.1's bit library, which the client has and the 5.3 VM here does not
    bit = {
        band = function(a, ...) for _, b in ipairs({ ... }) do a = a & b end return a end,
        bor = function(a, ...) for _, b in ipairs({ ... }) do a = a | b end return a end,
        bxor = function(a, ...) for _, b in ipairs({ ... }) do a = a ~ b end return a end,
        bnot = function(a) return (~a) & 0xFFFFFFFF end,
        lshift = function(a, n) return (a << n) & 0xFFFFFFFF end,
        rshift = function(a, n) return (a & 0xFFFFFFFF) >> n end,
    }
    tContains = function(t, v) for _, x in pairs(t) do if x == v then return true end end return false end
    tIndexOf = function(t, v) for i, x in ipairs(t) do if x == v then return i end end return nil end
    tInvert = function(t) local r = {}; for k, v in pairs(t) do r[v] = k end return r end
    tDeleteItem = function(t, v) local n = 0; for i = #t, 1, -1 do if t[i] == v then table.remove(t, i); n = n + 1 end end return n end
    CopyTable = function(t, shallow)
        local r = {}
        for k, v in pairs(t) do r[k] = (type(v) == "table" and not shallow) and CopyTable(v) or v end
        return r
    end
    MergeTable = function(a, b) for k, v in pairs(b) do a[k] = v end return a end
    Mixin = function(obj, ...)
        for i = 1, select("#", ...) do
            local m = select(i, ...)
            if type(m) == "table" then for k, v in pairs(m) do obj[k] = v end end
        end
        return obj
    end
    CreateFromMixins = function(...) return Mixin({}, ...) end
    CreateAndInitFromMixin = function(m, ...) local o = Mixin({}, m); if o.Init then o:Init(...) end return o end
    Clamp = function(v, lo, hi) return math.max(lo, math.min(hi, v)) end
    Lerp = function(a, b, t) return a + (b - a) * t end
    Saturate = function(v) return math.max(0, math.min(1, v)) end
    Round = function(v) return math.floor(v + 0.5) end
    local ColorMixin = {}
    function ColorMixin:GetRGB() return self.r, self.g, self.b end
    function ColorMixin:GetRGBA() return self.r, self.g, self.b, self.a end
    function ColorMixin:SetRGB(r, g, b) self.r, self.g, self.b = r, g, b end
    function ColorMixin:SetRGBA(r, g, b, a) self.r, self.g, self.b, self.a = r, g, b, a end
    function ColorMixin:GenerateHexColor() return string.format("ff%02x%02x%02x", math.floor(self.r * 255 + 0.5), math.floor(self.g * 255 + 0.5), math.floor(self.b * 255 + 0.5)) end
    function ColorMixin:WrapTextInColorCode(t) return "|c" .. self:GenerateHexColor() .. tostring(t) .. "|r" end
    function ColorMixin:IsEqualTo(o) return self.r == o.r and self.g == o.g and self.b == o.b and self.a == o.a end
    CreateColor = function(r, g, b, a) return Mixin({ r = r, g = g, b = b, a = a or 1 }, ColorMixin) end
    WHITE_FONT_COLOR, NORMAL_FONT_COLOR = CreateColor(1, 1, 1), CreateColor(1, 0.82, 0)
    HIGHLIGHT_FONT_COLOR, RED_FONT_COLOR, GREEN_FONT_COLOR, GRAY_FONT_COLOR =
        CreateColor(1, 1, 1), CreateColor(1, 0.13, 0.13), CreateColor(0.1, 1, 0.1), CreateColor(0.5, 0.5, 0.5)
    for _, c in pairs(RAID_CLASS_COLORS or {}) do Mixin(c, ColorMixin); c.a = c.a or 1 end

    local handler = function(err) P.Report("error handler", tostring(err)) end
    geterrorhandler = function() return handler end
    seterrorhandler = function(fn) if type(fn) == "function" then handler = fn end end
    debugstack = function() return (debug and debug.traceback) and debug.traceback("", 2) or "" end
    debugprofilestop = function() return P.now * 1000 end
    securecall = function(fn, ...) if type(fn) == "string" then fn = _G[fn] end return fn(...) end
    securecallfunction = securecall
    issecure = function() return false end
    issecurevariable = function() return false end
    forceinsecure = function() end
    scrub = function(...) return ... end
    GetLocale = function() return "enUS" end
    GetRealmName = function() return "Forever" end
    GetNormalizedRealmName = GetRealmName
    GetBuildInfo = function() return "1.16.1", "60001", "Nov 1 2026", 16001 end
    GetServerTime = function() return time() end
    GetFramerate = function() return 60 end
    GetScreenWidth = function() return P.W / (UIParent.__scale or 1) end
    GetScreenHeight = function() return P.H / (UIParent.__scale or 1) end
    GetPhysicalScreenSize = function() return P.W, P.H end
    UnitRace = function(u) if P.Unit(u) then return "Tauren", "Tauren", 6 end end
    UnitSex = function(u) return P.Unit(u) and 2 or nil end
    UnitFullName = function(u) local d = P.Unit(u); if d then return d.name, "Forever" end end
    UnitInParty, UnitInRaid, UnitIsAFK, UnitIsDND = function() return false end, function() return nil end, function() return false end, function() return false end
    UnitXP, UnitXPMax, GetXPExhaustion = function() return 0 end, function() return 1 end, function() return nil end
    GetMoney = function() return 1234567 end
    IsInGroup, IsInRaid, IsInGuild, IsInInstance = function() return false end, function() return false end, function() return false end, function() return false, "none" end
    GetNumGroupMembers, GetNumSubgroupMembers = function() return 0 end, function() return 0 end
    IsLoggedIn = function() return true end
    GetZoneText, GetSubZoneText, GetMinimapZoneText, GetRealZoneText = function() return "Mulgore" end, function() return "" end, function() return "Mulgore" end, function() return "Mulgore" end
    PlaySound, PlaySoundFile, StopSound = function() return true, 1 end, function() return true, 1 end, function() end
    local cvars = { uiScale = "1", useUiScale = "0", nameplateShowEnemies = "1" }
    GetCVar = function(k) return cvars[k] end
    SetCVar = function(k, v) cvars[k] = tostring(v); return true end
    GetCVarBool = function(k) return cvars[k] == "1" end
    C_CVar = { GetCVar = GetCVar, SetCVar = SetCVar, GetCVarBool = GetCVarBool, RegisterCVar = function() end }
    C_ChatInfo = {
        RegisterAddonMessagePrefix = function() return true end,
        IsAddonMessagePrefixRegistered = function() return true end,
        SendAddonMessage = function(prefix, text, channel) HOST_log("[addon message, not sent] " .. tostring(prefix) .. " " .. tostring(channel) .. ": " .. tostring(text)); return true end,
    }
    RegisterAddonMessagePrefix, SendAddonMessage = C_ChatInfo.RegisterAddonMessagePrefix, C_ChatInfo.SendAddonMessage
    ChatFrame_AddMessageEventFilter, ChatFrame_RemoveMessageEventFilter = function() end, function() end
    SendChatMessage = function(text, kind) HOST_log("[chat, not sent] " .. tostring(kind or "SAY") .. ": " .. tostring(text)) end
    ChatFrame1 = DEFAULT_CHAT_FRAME
    SELECTED_CHAT_FRAME = DEFAULT_CHAT_FRAME
    NUM_CHAT_WINDOWS = 1
    UIErrorsFrame = { AddMessage = function(_, m) DEFAULT_CHAT_FRAME:AddMessage(m) end }
    RaidNotice_AddMessage = function(_, m) DEFAULT_CHAT_FRAME:AddMessage(m) end
    WorldFrame = CreateFrame("Frame", "WorldFrame")
    InterfaceOptions_AddCategory = function() end
    InterfaceOptionsFrame_OpenToCategory = function() end
    InterfaceAddOnsList_Update = function() end
    local cat = 0
    Settings = {
        RegisterCanvasLayoutCategory = function(frame, name) cat = cat + 1; return { ID = cat, name = name, GetID = function(s) return s.ID end } end,
        RegisterCanvasLayoutSubcategory = function(parent, frame, name) cat = cat + 1; return { ID = cat, name = name, GetID = function(s) return s.ID end } end,
        RegisterVerticalLayoutCategory = function(name) cat = cat + 1; return { ID = cat, name = name, GetID = function(s) return s.ID end }, {} end,
        RegisterAddOnCategory = function() end,
        OpenToCategory = function() end,
    }
    WOW_PROJECT_MAINLINE, WOW_PROJECT_CLASSIC, WOW_PROJECT_BURNING_CRUSADE_CLASSIC, WOW_PROJECT_WRATH_CLASSIC = 1, 2, 5, 11
    WOW_PROJECT_ID = WOW_PROJECT_CLASSIC
    LE_EXPANSION_CLASSIC, LE_EXPANSION_LEVEL_CURRENT = 0, 0
    MAX_PLAYER_LEVEL = 60
    GetMaxPlayerLevel = function() return 60 end
    GetExpansionLevel = function() return 0 end
    BackdropTemplateMixin = {}
    ITEM_QUALITY_COLORS = {}
    for i, c in ipairs({ { 0.62, 0.62, 0.62 }, { 1, 1, 1 }, { 0.12, 1, 0 }, { 0, 0.44, 0.87 }, { 0.64, 0.21, 0.93 }, { 1, 0.5, 0 } }) do
        ITEM_QUALITY_COLORS[i - 1] = { r = c[1], g = c[2], b = c[3], hex = string.format("|cff%02x%02x%02x", c[1] * 255, c[2] * 255, c[3] * 255) }
    end
    C_Timer.NewTimer = function(d, fn)
        local t = { cancelled = false }
        P.timers[#P.timers + 1] = { at = P.now + (tonumber(d) or 0), fn = function() if not t.cancelled then fn(t) end end }
        t.Cancel = function() t.cancelled = true end
        t.IsCancelled = function() return t.cancelled end
        return t
    end
    CreateFont = function(name)
        local f = { __fontobj = name, __font = { STANDARD_TEXT_FONT, 12, "" } }
        function f:SetFont(path, size, flags) self.__font = { path, size, flags or "" } end
        function f:GetFont() return self.__font[1], self.__font[2], self.__font[3] end
        function f:SetTextColor() end
        function f:SetShadowColor() end
        function f:SetShadowOffset() end
        function f:SetJustifyH() end
        function f:SetJustifyV() end
        function f:SetSpacing() end
        function f:CopyFontObject() end
        function f:GetName() return name end
        if name then _G[name] = f end
        return f
    end
    GetBindingKey, SetBinding, SetBindingClick, SaveBindings, GetCurrentBindingSet = function() return nil end, function() return true end, function() return true end, function() end, function() return 1 end
    GetItemInfo, GetItemCount, GetSpellInfo = function() return nil end, function() return 0 end, function(id)
        local i = C_Spell.GetSpellInfo(id)
        if i then return i.name, nil, i.iconID, 0, 0, 0, i.spellID end
    end
    GetSpellCooldown = function(id) local c = C_Spell.GetSpellCooldown(id); return c.startTime, c.duration, 1, 1 end
    GetNumAddOns = C_AddOns.GetNumAddOns
    UnitBuff, UnitDebuff, UnitAura = function() return nil end, function() return nil end, function() return nil end
    InCombatLockdown = InCombatLockdown or function() return false end
    C_PvP, C_Item, C_Container = C_PvP or {}, C_Item or {}, C_Container or {}
    nop = function() end
end

---------------------------------------------------------------- globals the addons use
local function Install(class)
    seq = 0
    P.frames, P.updaters, P.timers, P.chat, P.watch = {}, {}, {}, {}, {}
    P.hover, P.down, P.focus, P.moving, P.dragging, P.sliding, P.csDrag = nil, nil, nil, nil, nil, nil, nil
    P.btn, P.downBy = {}, {}
    P.mx, P.my = 0, 0
    UIParent = New("Frame", "UIParent")
    UISpecialFrames = {}
    STANDARD_TEXT_FONT = "Fonts\\FRIZQT__.TTF"
    YES, NO = "Yes", "No"
    tinsert, tremove, wipe = table.insert, table.remove, function(t) for k in pairs(t) do t[k] = nil end return t end
    strsplit = nil
    local gold, white, grey = { 1, 0.82, 0, 1 }, { 1, 1, 1, 1 }, { 0.5, 0.5, 0.5, 1 }
    local function fo(name, size, color)
        FONTOBJ[name] = { path = STANDARD_TEXT_FONT, size = size, color = color }
        _G[name] = { __fontobj = name, GetFont = function() return STANDARD_TEXT_FONT, size, "" end }
    end
    fo("GameFontNormal", 12, gold); fo("GameFontNormalLarge", 16, gold); fo("GameFontNormalSmall", 10, gold)
    fo("GameFontNormalHuge", 20, gold)
    fo("GameFontHighlight", 12, white); fo("GameFontHighlightSmall", 10, white); fo("GameFontHighlightLarge", 16, white)
    fo("GameFontDisable", 12, grey); fo("GameFontDisableSmall", 10, grey)
    fo("NumberFontNormal", 12, white); fo("NumberFontNormalSmall", 10, white); fo("ChatFontNormal", 12, white)

    CreateFrame = function(kind, name, parent, template)
        if type(parent) == "string" then parent = _G[parent] end
        if type(kind) ~= "string" then error("CreateFrame: frame type expected", 2) end
        local w = New(kind, name, nil)
        Attach(w, parent)
        if template then Template(w, template) end
        if kind == "Cooldown" then w.__allPoints = (parent ~= nil) end
        if kind == "ColorSelect" then w.__hsv = { 0, 0, 1 } end   -- [studio] starts white, like the client's
        P.frames[#P.frames + 1] = w
        return w
    end

    GameTooltip = New("GameTooltip", "GameTooltip")
    GameTooltip.__shown = false
    GameTooltip.lines = {}
    function GameTooltip:SetOwner() self.lines = {}; self.__shown = false end
    function GameTooltip:ClearLines() self.lines = {} end
    function GameTooltip:SetText(t, r, g, b)
        self.lines = { { text = tostring(t), r = r or 1, g = g or 0.82, b = b or 0, size = 13 } }
        self.__shown = true
    end
    function GameTooltip:AddLine(t, r, g, b)
        self.lines[#self.lines + 1] = { text = tostring(t), r = r or 1, g = g or 0.82, b = b or 0, size = (#self.lines == 0) and 13 or 11 }
    end
    function GameTooltip:AddDoubleLine(a, b) self:AddLine(tostring(a) .. "  " .. tostring(b)) end
    function GameTooltip:SetUnit(u)
        local d = P.Unit(u)
        if not d then return end
        self.lines = {}
        self:AddLine(d.name, 1, 1, 1)
        self:AddLine("Level " .. d.level .. " " .. (d.player and d.className or d.creature), 1, 1, 1)
        self.__shown = true
    end
    function GameTooltip:SetUnitAura(u, i, filter)
        local a = C_UnitAuras.GetAuraDataByIndex(u, i, filter)
        if not a then return end
        self.lines = {}
        self:AddLine(a.name, 1, 1, 1)
        self.__shown = true
    end
    function GameTooltip:Show() self.__shown = true end
    function GameTooltip:Hide() self.__shown = false end
    GameTooltip_SetDefaultAnchor = function(tt) tt.lines = {}; tt.__shown = false end

    DEFAULT_CHAT_FRAME = { AddMessage = function(_, m) P.chat[#P.chat + 1] = { text = tostring(m), t = P.now }; HOST_log("[chat] " .. Strip(m)) end }
    print = function(...)
        local t = {}
        for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
        DEFAULT_CHAT_FRAME:AddMessage(table.concat(t, " "))
    end
    SlashCmdList = {}
    StaticPopupDialogs = {}
    StaticPopup_Show = function(key, a, b, data)
        local d = StaticPopupDialogs[key]
        if not d then return end
        local text = tostring(d.text or key)
        local ok, s = pcall(string.format, text, a or "", b or "")
        if ok then text = s end
        local popup = { data = data }
        if HOST_confirm(Strip(text)) then
            if d.OnAccept then Safe("popup", d.OnAccept, popup, data) end
        elseif d.OnCancel then
            Safe("popup", d.OnCancel, popup, data)
        end
    end
    PanelTemplates_SelectTab = function(t) t.__selected = true end
    PanelTemplates_DeselectTab = function(t) t.__selected = false end
    PanelTemplates_TabResize = function() end
    PanelTemplates_SetNumTabs = function() end
    PanelTemplates_SetTab = function() end
    hooksecurefunc = function(a, b, c)
        local tbl, name, hook = a, b, c
        if type(a) == "string" then tbl, name, hook = _G, a, b end
        local orig = tbl[name]
        if type(orig) ~= "function" then return end
        tbl[name] = function(...)
            local r = { orig(...) }
            hook(...)
            return unpack(r)
        end
    end
    issecretvalue = function() return false end
    canaccessvalue = function() return true end
    GetTime = function() return P.now end
    time = function() return 1700000000 + floor(P.now) end
    date = os and os.date or function() return "" end
    InCombatLockdown = function() return false end   -- the test space has no protected frames
    IsControlKeyDown = function() return P.ctrl and true or false end
    IsShiftKeyDown = function() return P.shift and true or false end
    IsAltKeyDown = function() return P.alt and true or false end
    IsModifierKeyDown = function() return (P.ctrl or P.shift or P.alt) and true or false end
    -- [studio] the cursor in screen pixels from the bottom left, the space
    -- UIParent:GetEffectiveScale() converts from (the canvas is the screen here)
    GetCursorPosition = function() return P.mx, P.H - P.my end
    IsMouseButtonDown = function(b)
        if b == nil then return next(P.btn) ~= nil end
        if type(b) == "number" then b = ({ "LeftButton", "RightButton", "MiddleButton", "Button4", "Button5" })[b] end
        return P.btn[b] and true or false
    end
    GetMouseFocus = function() return P.hover end
    GetMouseFoci = function() return { P.hover } end
    GetFonts = function() return {} end
    C_Timer = {
        After = function(d, fn) P.timers[#P.timers + 1] = { at = P.now + (tonumber(d) or 0), fn = fn } end,
        NewTicker = function(d, fn)
            local tk = { cancelled = false }
            local function again()
                if tk.cancelled then return end
                fn(tk)
                P.timers[#P.timers + 1] = { at = P.now + d, fn = again }
            end
            P.timers[#P.timers + 1] = { at = P.now + d, fn = again }
            tk.Cancel = function() tk.cancelled = true end
            return tk
        end,
    }
    -- [studio] true for exactly what the studio loaded (PV_file / PV_loaded)
    local function isLoaded(n)
        local on = P.loaded[tostring(n):lower()] and true or false
        return on, on
    end
    local function metadata(n, field)
        local m = P.meta[tostring(n):lower()]
        return m and m[tostring(field):lower()] or nil
    end
    C_AddOns = {
        IsAddOnLoaded = isLoaded, GetAddOnMetadata = metadata,
        IsAddOnLoadOnDemand = function() return false end,
        LoadAddOn = function(n) return isLoaded(n) and true or false, "MISSING" end,
        GetNumAddOns = function() local c = 0; for _ in pairs(P.loaded) do c = c + 1 end return c end,
        GetAddOnEnableState = function(n) return isLoaded(n) and 2 or 0 end,
        DoesAddOnExist = function(n) return (isLoaded(n)) end,
        EnableAddOn = function() end, DisableAddOn = function() end,
    }
    IsAddOnLoaded, GetAddOnMetadata, LoadAddOn = isLoaded, metadata, C_AddOns.LoadAddOn
    Enum = {
        StatusBarInterpolation = { Immediate = 0, ExponentialEaseOut = 1 },
        StatusBarTimerDirection = { ElapsedTime = 0, RemainingTime = 1 },
        PowerType = { Mana = 0, Rage = 1, Focus = 2, Energy = 3, ComboPoints = 4 },
    }
    RAID_CLASS_COLORS = {}
    for k, c in pairs({
        WARRIOR = { 0.78, 0.61, 0.43 }, ROGUE = { 1, 0.96, 0.41 }, MAGE = { 0.25, 0.78, 0.92 }, PRIEST = { 1, 1, 1 },
        WARLOCK = { 0.53, 0.53, 0.93 }, HUNTER = { 0.67, 0.83, 0.45 }, DRUID = { 1, 0.49, 0.04 },
        SHAMAN = { 0, 0.44, 0.87 }, PALADIN = { 0.96, 0.55, 0.73 },
    }) do
        RAID_CLASS_COLORS[k] = { r = c[1], g = c[2], b = c[3], colorStr = string.format("ff%02x%02x%02x", c[1] * 255, c[2] * 255, c[3] * 255) }
    end
    FACTION_BAR_COLORS = {
        { r = 0.8, g = 0.3, b = 0.22 }, { r = 0.8, g = 0.3, b = 0.22 }, { r = 0.75, g = 0.27, b = 0 },
        { r = 0.9, g = 0.7, b = 0 }, { r = 0, g = 0.6, b = 0.1 }, { r = 0, g = 0.6, b = 0.1 },
        { r = 0, g = 0.6, b = 0.1 }, { r = 0, g = 0.6, b = 0.1 },
    }
    PowerBarColor = {
        MANA = { r = 0, g = 0, b = 1 }, RAGE = { r = 1, g = 0, b = 0 }, FOCUS = { r = 1, g = 0.5, b = 0.25 },
        ENERGY = { r = 1, g = 1, b = 0 },
    }
    PowerBarColor[0], PowerBarColor[1], PowerBarColor[2], PowerBarColor[3] =
        PowerBarColor.MANA, PowerBarColor.RAGE, PowerBarColor.FOCUS, PowerBarColor.ENERGY
    ColorPickerFrame = {
        SetupColorPickerAndShow = function(self, info)
            self.info = info
            self.r, self.g, self.b = info.r or 1, info.g or 1, info.b or 1
            HOST_color(self.r, self.g, self.b)
        end,
        GetColorRGB = function(self) return self.r or 1, self.g or 1, self.b or 1 end,
    }
    RegisterUnitWatch = function(f) P.watch[f] = true end
    UnregisterUnitWatch = function(f) P.watch[f] = nil end

    -- a plain minimap so the Map tab has something to act on
    local cluster = CreateFrame("Frame", "MinimapCluster", UIParent)
    cluster:SetSize(192, 192)
    cluster:SetPoint("TOPRIGHT", UIParent, "TOPRIGHT", -8, -8)
    local mm = CreateFrame("Frame", "Minimap", cluster)
    mm:SetSize(140, 140)
    mm:SetPoint("CENTER", cluster, "TOP", 9, -92)
    mm.__isMinimap = true
    mm.__mask = 186178
    local zone = CreateFrame("Button", "MinimapZoneTextButton", cluster)
    zone:SetSize(140, 14)
    zone:SetPoint("BOTTOM", mm, "TOP", 0, 6)
    local zt = zone:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    zt:SetPoint("CENTER")
    zt:SetText("Mulgore")
    cluster.ZoneTextButton = zone
    local function mini(name, label, point, x, y)
        local b = CreateFrame("Button", name, mm)
        b:SetSize(18, 18)
        b:SetPoint("CENTER", mm, point, x, y)
        b:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8X8", edgeFile = "Interface\\Buttons\\WHITE8X8", edgeSize = 1 })
        b:SetBackdropColor(0.1, 0.1, 0.12, 0.9)
        b:SetBackdropBorderColor(0.6, 0.5, 0.2, 1)
        local t = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
        t:SetPoint("CENTER")
        t:SetText(label)
        return b
    end
    mm.ZoomIn = mini("MinimapZoomIn", "+", "BOTTOMRIGHT", -6, 28)
    mm.ZoomOut = mini("MinimapZoomOut", "-", "BOTTOMRIGHT", -24, 10)
    cluster.Tracking = mini("MiniMapTracking", "T", "TOPLEFT", 8, -8)
    mini("GameTimeFrame", "14", "TOPRIGHT", -6, -8)
    local clock = mini("TimeManagerClockButton", "7:42", "BOTTOM", 0, -4)
    clock:SetSize(40, 16)

    P.StudioGlobals()
    P.SimInstall(class)
end

---------------------------------------------------------------- simulation
local CLASSNAME = { WARRIOR = "Warrior", ROGUE = "Rogue", MAGE = "Mage", PRIEST = "Priest", WARLOCK = "Warlock",
    HUNTER = "Hunter", DRUID = "Druid", SHAMAN = "Shaman", PALADIN = "Paladin" }
local TOKEN = { [0] = "MANA", [1] = "RAGE", [2] = "FOCUS", [3] = "ENERGY" }
local S

local function Dur(start, duration)
    local d = { start = start, duration = duration }
    function d:GetRemainingDuration() return max(0, self.start + self.duration - P.now) end
    function d:GetElapsedDuration() return max(0, min(self.duration, P.now - self.start)) end
    function d:GetTotalDuration() return self.duration end
    function d:GetStartTime() return self.start end
    function d:GetEndTime() return self.start + self.duration end
    function d:IsZero() return self.duration <= 0 end
    function d:Fraction() if self.duration <= 0 then return 0 end return max(0, min(1, (P.now - self.start) / self.duration)) end
    function d:EvaluateRemainingPercent() return 1 - self:Fraction() end
    function d:EvaluateElapsedPercent() return self:Fraction() end
    return d
end

function P.Unit(u)
    if u == "player" then return S.player end
    if u == "target" then return S.target end
    if u == "targettarget" then return S.target and S.combat and S.player or nil end
    return nil
end

local TARGETS = {
    enemy = { name = "Venture Co. Taskmaster", level = 12, creature = "Humanoid", reaction = 2, hpmax = 2400, ptype = 0, pmax = 900,
        casts = { "Shadow Bolt", "Fireball" } },
    friend = { name = "Oneblghome", level = 60, player = true, class = "SHAMAN", reaction = 5, hpmax = 4100, ptype = 0, pmax = 5200,
        casts = { "Healing Wave" } },
    boss = { name = "Ragnaros", level = -1, creature = "Elemental", reaction = 1, hpmax = 1100000, ptype = 0, pmax = 100000,
        casts = { "Wrath of Ragnaros" } },
}

local function NewTarget(kind)
    local t = TARGETS[kind]
    if not t then S.target = nil; return end
    local d = {}
    for k, v in pairs(t) do d[k] = v end
    d.kind = kind
    d.className = d.class and CLASSNAME[d.class] or nil
    d.hp, d.power = d.hpmax, d.pmax
    d.auras = {}
    S.target = d
end

local function AddAura(u, name, icon, harmful, duration, mine, stacks)
    S.auraId = S.auraId + 1
    local a = { name = name, icon = icon, isHarmful = harmful, isHelpful = not harmful, duration = duration,
        expirationTime = duration > 0 and (P.now + duration) or 0, applications = stacks or 0,
        auraInstanceID = S.auraId, sourceUnit = mine and "player" or "target", isFromPlayerOrPlayerPet = mine,
        start = P.now, spellId = icon }
    u.auras[#u.auras + 1] = a
end

function P.SimInstall(class)
    local ptype = (class == "ROGUE" and 3) or (class == "WARRIOR" and 1) or 0
    S = { class = class, combat = false, auto = true, auraId = 0, cds = {}, spells = {}, tEnergy = 0, tSwing = 0, tAct = 0,
        tCast = 0, tHp = 0, tAura = 0, cp = 0 }
    P.sim = S
    S.player = { name = "Meatwagon", level = 60, player = true, class = class, className = CLASSNAME[class] or class,
        reaction = 5, hpmax = 4800, hp = 4800, ptype = ptype, pmax = (ptype == 0) and 4200 or 100,
        power = (ptype == 1) and 0 or ((ptype == 0) and 4200 or 100), auras = {}, leader = true }
    AddAura(S.player, "Mark of the Wild", 136078, false, 1800, false)
    AddAura(S.player, "Power Word: Fortitude", 135987, false, 1800, false)
    AddAura(S.player, "Battle Shout", 132333, false, 120, true)

    local function U(u) return P.Unit(u) end
    UnitExists = function(u) return U(u) ~= nil end
    UnitName = function(u) local d = U(u); return d and d.name or nil end
    UnitClass = function(u) local d = U(u); if not d then return nil end; return d.className or d.name, d.class or "WARRIOR" end
    UnitLevel = function(u) local d = U(u); return d and d.level or 0 end
    UnitHealth = function(u) local d = U(u); return d and floor(d.hp) or 0 end
    UnitHealthMax = function(u) local d = U(u); return d and d.hpmax or 0 end
    UnitPower = function(u, idx)
        local d = U(u)
        if not d then return 0 end
        if idx == 4 then return (d == S.player) and S.cp or 0 end
        if idx ~= nil and idx ~= d.ptype then return (idx == 0 and d == S.player and S.class == "DRUID") and 3000 or 0 end
        return floor(d.power)
    end
    UnitPowerMax = function(u, idx)
        local d = U(u)
        if not d then return 0 end
        if idx == 4 then return 5 end
        if idx ~= nil and idx ~= d.ptype then return (idx == 3 or idx == 1) and 100 or 4200 end
        return d.pmax
    end
    UnitPowerType = function(u) local d = U(u); if not d then return 0, "MANA" end; return d.ptype, TOKEN[d.ptype] end
    UnitIsPlayer = function(u) local d = U(u); return d and d.player or false end
    UnitReaction = function(u) local d = U(u); return d and d.reaction or nil end
    UnitFactionGroup = function(u) local d = U(u); if not d then return nil end; return "Horde", "Horde" end
    UnitCreatureType = function(u) local d = U(u); return d and (d.creature or "Humanoid") or nil end
    UnitIsPVP = function(u) local d = U(u); return d and d.player and d ~= S.player or false end
    UnitIsGroupLeader = function(u) local d = U(u); return d and d.leader or false end
    UnitThreatSituation = function(u) return (u == "player" and S.combat and S.target) and 3 or 0 end
    UnitAffectingCombat = function(u) return S.combat and U(u) ~= nil end
    UnitAttackSpeed = function() return S.class == "ROGUE" and 1.8 or 2.6, 1.5 end
    UnitGetIncomingHeals = function(u) local d = U(u); return d and d.incoming or 0 end
    UnitHasIncomingResurrection = function() return false end
    UnitPhaseReason = function() return nil end
    UnitIsDead = function(u) local d = U(u); return d and d.hp <= 0 or false end
    UnitIsDeadOrGhost = UnitIsDead
    UnitIsConnected = function() return true end
    UnitIsUnit = function(a, b) return U(a) ~= nil and U(a) == U(b) end
    UnitGUID = function(u) local d = U(u); return d and ("Preview-" .. d.name) or nil end
    UnitClassification = function(u) local d = U(u); return d and d.kind == "boss" and "worldboss" or "normal" end
    UnitIsTapDenied = function() return false end
    UnitIsFriend = function(a, b) local d = U(b); return d and d.reaction >= 5 or false end
    UnitCanAttack = function(a, b) local d = U(b); return d and d.reaction < 4 or false end
    GetComboPoints = function() return S.cp end
    GetRaidTargetIndex = function(u) return (u == "target" and S.target and S.target.kind ~= "friend") and 8 or nil end
    SetRaidTargetIconTexture = function(tex, idx) tex.__raidIndex = idx end
    SetPortraitTexture = function(tex, u)
        local d = U(u)
        tex.__texture = "portrait"
        tex.__portrait = d and { cls = d.class or "", name = d.name } or nil
    end
    IsResting = function() return not S.combat and S.resting or false end
    IsMounted = function() return false end
    GetShapeshiftForm = function() return 0 end
    local function castInfo(u, channel)
        local d = U(u)
        local c = d and d.cast
        if not c or (c.channel or false) ~= channel then return nil end
        return c.name, c.name, 136197, c.start * 1000, (c.start + c.duration) * 1000, false, channel and nil or c.id,
            c.shielded or false, 686
    end
    UnitCastingInfo = function(u) return castInfo(u, false) end
    UnitChannelInfo = function(u) return castInfo(u, true) end
    local function castDur(u, channel)
        local d = U(u)
        local c = d and d.cast
        if not c or (c.channel or false) ~= channel then return nil end
        return Dur(c.start, c.duration)
    end
    UnitCastingDuration = function(u) return castDur(u, false) end
    UnitChannelDuration = function(u) return castDur(u, true) end
    local function auraMatch(a, filter)
        filter = filter or "HELPFUL"
        if filter:find("HARMFUL") and not a.isHarmful then return false end
        if filter:find("HELPFUL") and a.isHarmful then return false end
        if filter:find("PLAYER") and not a.isFromPlayerOrPlayerPet then return false end
        return true
    end
    local function auraById(u, id)
        local d = U(u)
        if not d then return nil end
        for _, a in ipairs(d.auras) do if a.auraInstanceID == id then return a end end
    end
    C_UnitAuras = {
        GetAuraDataByIndex = function(u, i, filter)
            local d = U(u)
            if not d then return nil end
            local n = 0
            for _, a in ipairs(d.auras) do
                if auraMatch(a, filter) then
                    n = n + 1
                    if n == i then return a end
                end
            end
        end,
        GetAuraDuration = function(u, id)
            local a = auraById(u, id)
            if not a or a.duration <= 0 then return nil end
            return Dur(a.start, a.duration)
        end,
        GetAuraApplicationDisplayCount = function(u, id, lo)
            local a = auraById(u, id)
            if not a or a.applications < (lo or 2) then return "" end
            return tostring(a.applications)
        end,
        GetAuraDataByAuraInstanceID = auraById,
    }
    C_Spell = {
        GetSpellInfo = function(id)
            if id == nil then return nil end
            -- [studio] A spell asked for by NAME is answered "not known": the studio has no
            -- spell database, and the preview's answer (spell ID 0 for every name) made every
            -- ability share one ID and so one cooldown. The HUDs then keep their own rank-1 ID.
            if type(id) == "string" and not tonumber(id) then return nil end
            local num = tonumber(id) or 0
            if num > 0 then S.spells[num] = true end
            return { name = type(id) == "string" and id or ("Spell " .. num), iconID = (num > 0) and num or 134400, spellID = num, castTime = 0 }
        end,
        GetSpellCooldown = function(id)
            local c = S.cds[tonumber(id) or 0]
            if c and c.start + c.duration > P.now then
                return { startTime = c.start, duration = c.duration, isEnabled = true, modRate = 1 }
            end
            return { startTime = 0, duration = 0, isEnabled = true, modRate = 1 }
        end,
        GetSpellCooldownDuration = function(id)
            local c = S.cds[tonumber(id) or 0]
            if c and c.start + c.duration > P.now then return Dur(c.start, c.duration) end
            return nil
        end,
        RequestLoadSpellData = function() end,
        IsSpellDataCached = function() return true end,
        GetSpellTexture = function(id) return tonumber(id) or 134400 end,
        GetSpellName = function(id) return "Spell " .. tostring(id) end,
        IsSpellUsable = function() return true, false end,
    }
    IsSpellKnown = function() return true end
    IsPlayerSpell = function() return true end
    C_Map = {
        GetBestMapForUnit = function() return 1412 end,
        GetPlayerMapPosition = function() return { GetXY = function() return 0.4812 + math.sin(P.now / 9) * 0.01, 0.5931 end } end,
    }
end

local function Power(d, v, token)
    v = max(0, min(d.pmax, v))
    if v == d.power then return end
    d.power = v
    P.Fire("UNIT_POWER_UPDATE", d == S.player and "player" or "target", token or TOKEN[d.ptype])
    P.Fire("UNIT_POWER_FREQUENT", d == S.player and "player" or "target", token or TOKEN[d.ptype])
end

local function Health(u, d, v)
    v = max(0, min(d.hpmax, v))
    if v == d.hp then return end
    d.hp = v
    P.Fire("UNIT_HEALTH", u)
    if u == "player" and S.target and S.combat then P.Fire("UNIT_HEALTH", "targettarget") end
end

local function StartCast(u, d, name, duration, channel)
    S.castId = (S.castId or 0) + 1
    d.cast = { name = name, start = P.now, duration = duration, channel = channel, id = "Cast-" .. S.castId,
        shielded = (d.kind == "boss") }
    P.Fire(channel and "UNIT_SPELLCAST_CHANNEL_START" or "UNIT_SPELLCAST_START", u, d.cast.id, 686)
end

local function SetCombat(on)
    if S.combat == on then return end
    S.combat = on
    P.Fire(on and "PLAYER_REGEN_DISABLED" or "PLAYER_REGEN_ENABLED")
    P.Fire("UNIT_THREAT_SITUATION_UPDATE", "player")
    P.Fire("UNIT_TARGET", "target")
    P.Fire("PLAYER_UPDATE_RESTING")
end

local function SetTarget(kind)
    NewTarget(kind)
    if S.target and S.target.kind ~= "friend" then
        AddAura(S.target, "Rend", 132155, true, 21, true)
        AddAura(S.target, "Sunder Armor", 132363, true, 30, true, 3)
        AddAura(S.target, "Curse of Weakness", 136138, true, 120, false)
        AddAura(S.target, "Enrage", 136224, false, 12, false)
    elseif S.target then
        AddAura(S.target, "Lightning Shield", 136051, false, 600, false, 3)
        AddAura(S.target, "Renew", 135953, false, 15, true)
    end
    P.Fire("PLAYER_TARGET_CHANGED")
    P.Fire("UNIT_TARGET", "player")
    P.Fire("UNIT_AURA", "target")
end

local function SimTick(dt)
    local pl, tg = S.player, S.target
    local fighting = S.combat and tg and tg.kind ~= "friend"
    -- finished casts
    for u, d in pairs({ player = pl, target = tg }) do
        if d and d.cast and P.now >= d.cast.start + d.cast.duration then
            local c = d.cast
            d.cast = nil
            P.Fire(c.channel and "UNIT_SPELLCAST_CHANNEL_STOP" or "UNIT_SPELLCAST_STOP", u, c.id, 686)
            P.Fire("UNIT_SPELLCAST_SUCCEEDED", u, c.id, 686)
        end
    end
    -- expired auras
    S.tAura = S.tAura + dt
    if S.tAura > 0.5 then
        S.tAura = 0
        for u, d in pairs({ player = pl, target = tg }) do
            if d then
                local changed
                for i = #d.auras, 1, -1 do
                    local a = d.auras[i]
                    if a.duration > 0 and a.expirationTime <= P.now then
                        if S.auto then a.start, a.expirationTime = P.now, P.now + a.duration
                        else table.remove(d.auras, i) end
                        changed = true
                    end
                end
                if changed then P.Fire("UNIT_AURA", u) end
            end
        end
    end
    -- resource regeneration
    S.tEnergy = S.tEnergy + dt
    if S.tEnergy >= 2 then
        S.tEnergy = S.tEnergy - 2
        if pl.ptype == 3 then Power(pl, pl.power + 20)
        elseif pl.ptype == 0 then Power(pl, pl.power + pl.pmax * (S.combat and 0.012 or 0.05))
        elseif pl.ptype == 1 and not S.combat then Power(pl, pl.power - 3) end
        if not S.combat then Health("player", pl, pl.hp + pl.hpmax * 0.05) end
    end
    if not S.auto then return end
    if fighting then
        S.tSwing = S.tSwing + dt
        local speed = UnitAttackSpeed()
        if S.tSwing >= speed then
            S.tSwing = S.tSwing - speed
            P.Fire("PLAYER_SWING")
            if pl.ptype == 1 then Power(pl, pl.power + 9) end
            Health("target", tg, tg.hp - tg.hpmax * 0.02)
        end
        S.tAct = S.tAct + dt
        if S.tAct >= 2.4 then
            S.tAct = 0
            local ids = {}
            for id in pairs(S.spells) do
                local c = S.cds[id]
                if not c or c.start + c.duration <= P.now then ids[#ids + 1] = id end
            end
            table.sort(ids)
            local cost = (pl.ptype == 0) and pl.pmax * 0.06 or 30
            if #ids > 0 and pl.power >= cost then
                local id = ids[math.random(#ids)]
                S.cds[id] = { start = P.now, duration = ({ 6, 10, 15, 30, 45 })[math.random(5)] }
                Power(pl, pl.power - cost)
                if pl.ptype ~= 0 then
                    S.cp = (S.cp >= 5) and 0 or (S.cp + 1)
                    P.Fire("UNIT_POWER_UPDATE", "player", "COMBO_POINTS")
                elseif not pl.cast then
                    StartCast("player", pl, "Frostbolt", 2.0, false)
                end
                P.Fire("SPELL_UPDATE_COOLDOWN")
                Health("target", tg, tg.hp - tg.hpmax * 0.05)
            end
        end
        S.tHp = S.tHp + dt
        if S.tHp >= 1.3 then
            S.tHp = 0
            local hit = pl.hpmax * (0.03 + math.random() * 0.06)
            if pl.hp - hit < pl.hpmax * 0.25 then
                pl.incoming = pl.hpmax * 0.3
                P.Fire("UNIT_HEAL_PREDICTION", "player")
                Health("player", pl, pl.hp + pl.hpmax * 0.5)
                pl.incoming = 0
                P.Fire("UNIT_HEAL_PREDICTION", "player")
            else
                Health("player", pl, pl.hp - hit)
            end
        end
        S.tCast = S.tCast + dt
        if S.tCast >= 7 and not tg.cast then
            S.tCast = 0
            StartCast("target", tg, tg.casts[math.random(#tg.casts)], 2.5, false)
        end
        if tg.hp <= 0 then SetTarget(tg.kind) end
    end
end

---------------------------------------------------------------- host entry points
-- [studio] Loading any addon, the way the client does it:
--   PV_begin(class, target)            a fresh UI for a character of that class
--   PV_meta(addon, field, value)       .toc fields (GetAddOnMetadata)
--   PV_saved(source, label)            run a SavedVariables file before the addon loads
--   PV_file(addon, path, source)       run one .lua file as chunk(addonName, sharedTable):
--                                      ONE shared table per addon, across all its files
--   PV_loaded(addon, "Var1,Var2")      every file is in: remember its SavedVariables
--                                      names and fire ADDON_LOADED
--   PV_start()                         PLAYER_LOGIN, PLAYER_ENTERING_WORLD
-- An error in a file is reported with file and line and the next file still runs.
function PV_begin(class, target)
    P.loaded, P.shared, P.sv, P.meta, P.errSeen, P.errCount = {}, {}, {}, {}, {}, 0
    Install(class)
    P.addon = target
    return true
end

function PV_meta(addon, field, value)
    local key = tostring(addon):lower()
    P.meta[key] = P.meta[key] or {}
    P.meta[key][tostring(field):lower()] = value
    return true
end

function PV_saved(source, label)
    if type(source) ~= "string" or source == "" then return false end
    local sv, err = (loadstring or load)(source, "@" .. (label or "SavedVariables"))
    if not sv then Report("saved settings", err); return false end
    return Safe("saved settings", sv)
end

function PV_file(addon, path, source)
    local key = tostring(addon):lower()
    P.loaded[key] = true                    -- IsAddOnLoaded is already true while an addon's own files run
    P.shared[key] = P.shared[key] or {}
    local chunk, err = (loadstring or load)(source, "@" .. addon .. "\\" .. path)
    if not chunk then Report("load " .. addon .. "\\" .. path, err); return false end
    return Safe("load " .. addon .. "\\" .. path, chunk, addon, P.shared[key])
end

function PV_loaded(addon, savedNames)
    local key = tostring(addon):lower()
    P.loaded[key] = true
    local names = {}
    for n in tostring(savedNames or ""):gmatch("[^,%s]+") do names[#names + 1] = n end
    P.sv[key] = names
    P.Fire("ADDON_LOADED", addon)
    return true
end

function PV_start()
    P.Fire("VARIABLES_LOADED")
    P.Fire("PLAYER_LOGIN")
    P.Fire("PLAYER_ENTERING_WORLD", true, false)
    P.db = P.addon and _G[P.addon .. "_DB"] or nil
    return true
end

-- [studio] SavedVariables -> Lua source, in the shape the client writes them:
--   Name = {
--       ["key"] = value,
--   }
-- Functions, userdata and widgets cannot be saved and are left out; a table met
-- a second time on the way down (a cycle) is left out too.
local function SerKey(k)
    if type(k) == "string" then return "[" .. string.format("%q", k):gsub("\\\n", "\\n") .. "]" end
    if type(k) == "number" then
        if k == floor(k) and k > -1e15 and k < 1e15 then return string.format("[%d]", k) end
        return "[" .. string.format("%.17g", k) .. "]"
    end
    if type(k) == "boolean" then return "[" .. tostring(k) .. "]" end
    return nil
end
local function SerNum(v)
    if v ~= v then return "0" end
    if v == math.huge then return "math.huge" elseif v == -math.huge then return "-math.huge" end
    if v == floor(v) and v > -1e15 and v < 1e15 then return string.format("%d", v) end
    local s = string.format("%.14g", v)
    if tonumber(s) ~= v then s = string.format("%.17g", v) end
    return s
end
local function Ser(v, indent, path, buf)
    local tv = type(v)
    if tv == "string" then buf[#buf + 1] = (string.format("%q", v):gsub("\\\n", "\\n"))
    elseif tv == "number" then buf[#buf + 1] = SerNum(v)
    elseif tv == "boolean" then buf[#buf + 1] = tostring(v)
    elseif tv == "table" then
        if path[v] or getmetatable(v) == Widget then buf[#buf + 1] = "nil"; return end
        path[v] = true
        buf[#buf + 1] = "{\n"
        local inner = indent .. "\t"
        local n = #v
        for i = 1, n do
            local x = v[i]
            local tx = type(x)
            if tx == "string" or tx == "number" or tx == "boolean" or tx == "table" then
                buf[#buf + 1] = inner
                Ser(x, inner, path, buf)
                buf[#buf + 1] = ", -- [" .. i .. "]\n"
            else
                buf[#buf + 1] = inner .. "nil, -- [" .. i .. "]\n"
            end
        end
        local keys = {}
        for k, x in pairs(v) do
            local tx = type(x)
            local isArr = type(k) == "number" and k == floor(k) and k >= 1 and k <= n
            if not isArr and (tx == "string" or tx == "number" or tx == "boolean" or tx == "table") and SerKey(k) then
                keys[#keys + 1] = k
            end
        end
        table.sort(keys, function(a, b)
            local ta, tb = type(a), type(b)
            if ta ~= tb then return ta < tb end
            if ta == "boolean" then return (a and 1 or 0) < (b and 1 or 0) end
            return a < b
        end)
        for _, k in ipairs(keys) do
            buf[#buf + 1] = inner .. SerKey(k) .. " = "
            Ser(v[k], inner, path, buf)
            buf[#buf + 1] = ",\n"
        end
        buf[#buf + 1] = indent .. "}"
        path[v] = nil
    else
        buf[#buf + 1] = "nil"
    end
end
P.Ser = Ser

-- the addon's SavedVariables as one Lua file; "" when it declares none
function PV_serialize(addon)
    local names = P.sv[tostring(addon):lower()]
    if not names or #names == 0 then return "" end
    local buf = { "\n" }
    for _, name in ipairs(names) do
        buf[#buf + 1] = name .. " = "
        Ser(_G[name], "", {}, buf)
        buf[#buf + 1] = "\n"
    end
    return table.concat(buf)
end

-- PLAYER_LOGOUT is when addons that keep their settings in locals copy them back
function PV_logout()
    P.Fire("PLAYER_LOGOUT")
    return true
end

-- [studio] run a line of Lua (the /run of the game; also what the headless checks read values with)
function PV_eval(code)
    local fn, err = load("return " .. code, "=/run")
    if not fn then fn, err = load(code, "=/run") end
    if not fn then return "error: " .. tostring(err) end
    local ok, res = xpcall(fn, Trace)
    if not ok then return "error: " .. tostring(res) end
    return tostring(res)
end

-- screen box of a named frame, "x y w h" in canvas pixels ("" when it has none)
function PV_rect(name)
    local f = _G[name]
    local r = type(f) == "table" and Rect(f)
    if not r then return "" end
    return string.format("%.2f %.2f %.2f %.2f", r.x, r.y, r.w, r.h)
end

function PV_errors() return tostring(P.errCount or 0) end

-- The preview's single-file entry point, kept for its callers.
function PV_boot(name, class, source, saved, hasFonts)
    PV_begin(class, name)
    if hasFonts then P.loaded["foreverfonts"] = true end
    PV_saved(saved, "SavedVariables")
    local chunk, err = (loadstring or load)(source, "@" .. name .. ".lua")
    if not chunk then error(err) end
    P.loaded[name:lower()] = true
    chunk(name, {})
    P.Fire("ADDON_LOADED", name)
    P.Fire("PLAYER_LOGIN")
    P.Fire("PLAYER_ENTERING_WORLD", true, false)
    P.db = _G[name .. "_DB"]
    return true
end

function PV_frame(dt, W, H, k)
    P.W, P.H = W, H
    UIParent.__scale = k
    UIParent.__w, UIParent.__h = W / k, H / k
    Dirty()
    P.now = P.now + dt
    Safe("sim", SimTick, dt)
    if #P.timers > 0 then
        local due, keep = {}, {}
        for _, t in ipairs(P.timers) do
            if t.at <= P.now then due[#due + 1] = t else keep[#keep + 1] = t end
        end
        P.timers = keep
        for _, t in ipairs(due) do Safe("timer", t.fn) end
    end
    for f in pairs(P.watch) do
        local u = f.__attr and f.__attr.unit
        local want = u and UnitExists(u) or false
        if f.__shown ~= want then f:SetShown(want) end
    end
    local run = {}
    for f in pairs(P.updaters) do
        if Visible(f) then run[#run + 1] = f end
    end
    table.sort(run, function(a, b) return a.__seq < b.__seq end)
    for _, f in ipairs(run) do
        local fn = f.__scripts.OnUpdate
        if fn then Safe("OnUpdate", fn, f, dt) end
    end
    -- frames sized by their anchors tell their scripts when the size changes
    Dirty()
    for _, f in ipairs(P.frames) do
        local fn = f.__scripts.OnSizeChanged
        if fn and Visible(f) then
            local r = Rect(f)
            if r then
                local s = Scale(f)
                local w, h = floor(r.w / s + 0.5), floor(r.h / s + 0.5)
                if f.__lastW ~= w or f.__lastH ~= h then
                    local first = f.__lastW == nil
                    f.__lastW, f.__lastH = w, h
                    if not first then Safe("OnSizeChanged", fn, f, r.w / s, r.h / s) end
                end
            end
        end
    end
    return Draw()
end

function PV_slash(text)
    local cmd, rest = text:match("^(/%S+)%s*(.-)$")
    if not cmd then return false end
    cmd = cmd:lower()
    -- [studio] the client's own /run and /reload
    if cmd == "/run" or cmd == "/script" then
        local fn, err = load(rest or "", "=/run")
        if not fn then Report("/run", err) else Safe("/run", fn) end
        return true
    end
    if cmd == "/reload" or cmd == "/rl" then return "reload" end
    for key, fn in pairs(SlashCmdList) do
        local i = 1
        while _G["SLASH_" .. key .. i] do
            if _G["SLASH_" .. key .. i]:lower() == cmd then
                Safe("slash", fn, rest or "")
                return true
            end
            i = i + 1
        end
    end
    return false
end

function PV_cmd(what, arg)
    if what == "combat" then SetCombat(arg == "1")
    elseif what == "target" then SetTarget(arg)
    elseif what == "auto" then S.auto = (arg == "1")
    elseif what == "resting" then S.resting = (arg == "1"); P.Fire("PLAYER_UPDATE_RESTING")
    elseif what == "color" then
        local r, g, b = arg:match("^([%d.]+),([%d.]+),([%d.]+)$")
        local cp = ColorPickerFrame
        if r and cp.info then
            cp.r, cp.g, cp.b = tonumber(r), tonumber(g), tonumber(b)
            if cp.info.swatchFunc then Safe("colour", cp.info.swatchFunc) end
        end
    elseif what == "fonts" then
        P.ClearMeasure()
    elseif what == "showcase" then
        -- switch everything on through the addon's own tables, then let it apply
        local db = P.db
        if type(db) ~= "table" then return end
        db.autoHideOOC, db.shown = false, true
        if type(db.elements) == "table" then
            for _, e in pairs(db.elements) do if type(e) == "table" then e.enabled = true end end
        end
        if type(db.spells) == "table" then
            for _, s in pairs(db.spells) do if type(s) == "table" then s.enabled = true end end
        end
        if type(db.frames) == "table" then
            for key, f in pairs(db.frames) do
                if type(f) == "table" then
                    f.enabled = true
                    f.portrait = (key ~= "targettarget")
                    f.abOn = (key == "target")
                    f.powerText = (key ~= "targettarget")
                end
            end
            if db.frames.player then db.frames.player.classbar = true; db.frames.player.bOn = true end
        end
        if type(db.map) == "table" then db.map.skin, db.map.coords = true, true end
        for key in pairs(SlashCmdList) do
            local s1 = _G["SLASH_" .. key .. "1"]
            if s1 then PV_slash(s1 .. " apply") end
        end
    end
end
