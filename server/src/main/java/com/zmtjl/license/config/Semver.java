package com.zmtjl.license.config;

/** 简单的 1~4 段数字版本号比较，忽略前缀 v 和预发布后缀。 */
public final class Semver {
    private Semver() {}

    public static boolean isValid(String value) {
        try {
            parse(value);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    public static int compare(String left, String right) {
        int[] a = parse(left);
        int[] b = parse(right);
        for (int i = 0; i < 4; i++) {
            int c = Integer.compare(a[i], b[i]);
            if (c != 0) return c;
        }
        return 0;
    }

    private static int[] parse(String raw) {
        if (raw == null) throw new IllegalArgumentException("版本号为空");
        String value = raw.trim();
        if (value.startsWith("v") || value.startsWith("V")) value = value.substring(1);
        int cut = value.indexOf('-');
        if (cut >= 0) value = value.substring(0, cut);
        cut = value.indexOf('+');
        if (cut >= 0) value = value.substring(0, cut);
        String[] parts = value.split("\\.");
        if (parts.length == 0 || parts.length > 4) {
            throw new IllegalArgumentException("版本号格式错误");
        }
        int[] out = new int[4];
        for (int i = 0; i < parts.length; i++) {
            if (!parts[i].matches("\\d{1,9}")) {
                throw new IllegalArgumentException("版本号格式错误");
            }
            out[i] = Integer.parseInt(parts[i]);
        }
        return out;
    }
}
